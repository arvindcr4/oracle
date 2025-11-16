import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ensureGeminiPromptReady,
	navigateToGemini,
	submitGeminiPrompt,
	waitForGeminiResponse,
} from "../gemini/actions.js";
import { formatElapsed } from "../oracle/format.js";
import { verifyAttachmentsVisible } from "./actions/attachments.js";
import {
	connectToChrome,
	hideChromeWindow,
	launchChrome,
	registerTerminationHooks,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { syncCookies } from "./cookies.js";
import {
	captureAssistantMarkdown,
	ensureModelSelection,
	ensureNotBlocked,
	ensurePromptReady,
	navigateToChatGPT,
	readAssistantSnapshot,
	submitPrompt,
	uploadAttachmentFile,
	waitForAssistantResponse,
	waitForAttachmentCompletion,
} from "./pageActions.js";
import { saveSessionState, waitForConversationUrl } from "./sessionRecovery.js";
import type {
	BrowserAttachment,
	BrowserLogger,
	BrowserRunOptions,
	BrowserRunResult,
	ChromeClient,
} from "./types.js";
import { estimateTokenCount, withRetries } from "./utils.js";
import { acquireBrowserLock } from "./lock.js";

export { CHATGPT_URL, DEFAULT_MODEL_TARGET } from "./constants.js";
export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { delay, parseDuration } from "./utils.js";

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
	const promptText = options.prompt?.trim();
	if (!promptText) {
		throw new Error("Prompt text is required when using browser mode.");
	}

	const attachments: BrowserAttachment[] = options.attachments ?? [];

	const config = resolveBrowserConfig(options.config);
	const isGemini = typeof config.url === "string" && config.url.includes("gemini.google.com");
	const logger: BrowserLogger = options.log ?? ((_message: string) => {});
	if (logger.verbose === undefined) {
		logger.verbose = Boolean(config.debug);
	}
	if (logger.sessionLog === undefined && options.log?.sessionLog) {
		logger.sessionLog = options.log.sessionLog;
	}
	if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
		logger(
			`[browser-mode] config: ${JSON.stringify({
				...config,
				promptLength: promptText.length,
			})}`,
		);
	}

	let releaseBrowserLock: (() => Promise<void>) | null = null;
	const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-"));
	logger(`Created temporary Chrome profile at ${userDataDir}`);

	releaseBrowserLock = await acquireBrowserLock({ logger });

	const chrome = await launchChrome(config, userDataDir, logger);
	let removeTerminationHooks: (() => void) | null = null;
	try {
		removeTerminationHooks = registerTerminationHooks(
			chrome,
			userDataDir,
			config.keepBrowser,
			logger,
		);
	} catch {
		// ignore failure; cleanup still happens below
	}

	let client: Awaited<ReturnType<typeof connectToChrome>> | null = null;
	const startedAt = Date.now();
	let answerText = "";
	let answerMarkdown = "";
	let answerHtml = "";
	let runStatus: "attempted" | "complete" = "attempted";
	let connectionClosedUnexpectedly = false;
	let stopThinkingMonitor: (() => void) | null = null;

	try {
		client = await connectToChrome(chrome.port, logger);
		const markConnectionLost = () => {
			connectionClosedUnexpectedly = true;
		};
		client.on("disconnect", markConnectionLost);
		const { Network, Page, Runtime, Input, DOM } = client;

		if (!config.headless && config.hideWindow) {
			await hideChromeWindow(chrome, logger);
		}

		const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
		if (DOM && typeof DOM.enable === "function") {
			domainEnablers.push(DOM.enable());
		}
		await Promise.all(domainEnablers);
		await Network.clearBrowserCookies();

		if (config.cookieSync) {
			const cookieCount = await syncCookies(
				Network,
				config.url,
				config.chromeProfile,
				logger,
				config.allowCookieErrors ?? false,
			);
			logger(
				cookieCount > 0
					? `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
					: "No Chrome cookies found; continuing without session reuse",
			);
		} else {
			logger("Skipping Chrome cookie sync (--browser-no-cookie-sync)");
		}

		if (isGemini) {
			await navigateToGemini(Page, Runtime, config.url, logger);
			await ensureGeminiPromptReady(Runtime, config.inputTimeoutMs, logger);
			logger(`Gemini prompt ready (${promptText.length.toLocaleString()} chars queued)`);
			if (attachments.length > 0) {
				logger(
					"Gemini mode does not yet support file uploads; attached files were already inlined into the prompt when possible.",
				);
			}
			await submitGeminiPrompt(Runtime, promptText, logger);
			const text = await waitForGeminiResponse(Runtime, config.timeoutMs, logger);
			answerText = text;
			answerMarkdown = text;
		} else {
			await navigateToChatGPT(Page, Runtime, config.url, logger);
			await ensureNotBlocked(Runtime, config.headless, logger);
			await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
			logger(
				`Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
			);
			if (config.desiredModel) {
				await withRetries(
					() => ensureModelSelection(Runtime, config.desiredModel as string, logger),
					{
						retries: 2,
						delayMs: 300,
						onRetry: (attempt, error) => {
							if (options.verbose) {
								logger(
									`[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
								);
							}
						},
					},
				);
				await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
				logger(
					`Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
				);
			}
			if (attachments.length > 0) {
				if (!DOM) {
					throw new Error("Chrome DOM domain unavailable while uploading attachments.");
				}
				// Upload attachments sequentially
				for (const attachment of attachments) {
					logger(`Uploading attachment: ${attachment.displayPath}`);
					await uploadAttachmentFile({ runtime: Runtime, dom: DOM }, attachment, logger);
				}
				const waitBudget = Math.max(config.inputTimeoutMs ?? 30_000, 30_000);

				// Best-effort wait for ChatGPT to finish processing uploads and re-enable the composer.
				// In practice the page may refresh or temporarily disable the send button while uploads
				// continue in the background, so we treat this as an optimization rather than a hard gate
				// and fall back to visible-attachment checks when it flakes.
				let initialWaitCompleted = false;
				try {
					await waitForAttachmentCompletion(Runtime, waitBudget, logger, {
						page: Page,
						userDataDir,
					});
					initialWaitCompleted = true;
					logger("All attachments uploaded");
				} catch (waitError) {
					const message =
						waitError instanceof Error ? waitError.message : String(waitError ?? "unknown error");
					logger(
						`Attachment readiness check hit an error (${message}). ` +
							"Falling back to verifying visible attachments in the composer before submitting.",
					);
				}

				// Verify attachments are visibly present in the composer before submitting
				const normalizeFilename = (filename: string): string => {
					return filename
						.toLowerCase()
						.trim()
						.replace(/^["']|["']$/g, "") // Remove wrapping quotes
						.replace(/\s+/g, " ") // Collapse whitespace
						.replace(/\s*\(\d+\)$/, "") // Remove ChatGPT's " (1)" suffix for duplicates
						.trim();
				};

				const expectedFilenames = attachments.map((att) =>
					normalizeFilename(path.basename(att.path)),
				);
				const visibleAttachments = await verifyAttachmentsVisible(
					Runtime,
					{ timeout: 10000 },
					logger,
				);
				const visibleFilenames = visibleAttachments.map((att) => normalizeFilename(att.filename));

				const missingFiles = expectedFilenames.filter((exp) => !visibleFilenames.includes(exp));
				const extraFiles = visibleFilenames.filter((vis) => !expectedFilenames.includes(vis));

				if (
					missingFiles.length > 0 ||
					(extraFiles.length > 0 && visibleFilenames.length !== expectedFilenames.length)
				) {
					logger("❌ Attachment verification failed!");
					logger(
						`Expected ${expectedFilenames.length} attachment(s): [${expectedFilenames.join(", ")}]`,
					);
					logger(
						`Visible ${visibleFilenames.length} attachment(s): [${visibleFilenames.join(", ")}]`,
					);

					if (missingFiles.length > 0) {
						logger(`Missing: [${missingFiles.join(", ")}]`);
					}
					if (extraFiles.length > 0) {
						logger(`Extra/unexpected: [${extraFiles.join(", ")}]`);
					}

					// Log DOM debug info for first few visible attachments
					if (visibleAttachments.length > 0) {
						logger("Visible attachment DOM samples (first 2):");
						visibleAttachments.slice(0, 2).forEach((att, idx) => {
							logger(`  [${idx + 1}] ${att.filename}`);
							logger(`      Selector: ${att.selector}`);
							if (att.outerHTML) {
								logger(`      HTML: ${att.outerHTML.substring(0, 200)}...`);
							}
						});
					}

					throw new Error(
						`Expected ${expectedFilenames.length} attachment(s) but only ${visibleFilenames.length} visible in composer. ` +
							`Missing: [${missingFiles.join(", ") || "none"}]. ` +
							`Visible: [${visibleFilenames.join(", ") || "none"}]`,
					);
				}

				logger(
					`✓ Verified ${visibleFilenames.length}/${expectedFilenames.length} attachment(s) visible in composer`,
				);

				// Double-check that the send button is enabled and attachments are ready.
				// If the initial wait already failed, we skip this strict check to avoid
				// treating minor UI reloads as fatal now that the attachments are visible.
				if (initialWaitCompleted) {
					logger("Double-checking attachment readiness before submission...");
					await waitForAttachmentCompletion(Runtime, 5000, logger, {
						page: Page,
						userDataDir,
					});
					logger("✓ Attachments confirmed ready; proceeding to submit");
				} else {
					logger(
						"Skipping final attachment readiness double-check due to earlier flakiness; " +
							"attachments are visible, proceeding to submit.",
					);
				}
			}
			await submitPrompt({ runtime: Runtime, input: Input }, promptText, logger);

			// Wait for and save the conversation URL
			const conversationUrl = await waitForConversationUrl(Runtime, 5000, logger);
			const attachmentPathsToSave = attachments.map((a) => a.path);
			await saveSessionState(userDataDir, conversationUrl, promptText, attachmentPathsToSave);
			logger(`Session state saved to ${userDataDir}`);

			stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
			const answer = await waitForAssistantResponse(Runtime, config.timeoutMs, logger);
			answerText = answer.text;
			answerHtml = answer.html ?? "";
			const copiedMarkdown = await withRetries(
				async () => {
					const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
					if (!attempt) {
						throw new Error("copy-missing");
					}
					return attempt;
				},
				{
					retries: 2,
					delayMs: 350,
					onRetry: (attempt, error) => {
						if (options.verbose) {
							logger(
								`[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
							);
						}
					},
				},
			).catch(() => null);
			answerMarkdown = copiedMarkdown ?? answerText;
		}
		stopThinkingMonitor?.();
		runStatus = "complete";
		const durationMs = Date.now() - startedAt;
		const answerChars = answerText.length;
		const answerTokens = estimateTokenCount(answerMarkdown);
		return {
			answerText,
			answerMarkdown,
			answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
			tookMs: durationMs,
			answerTokens,
			answerChars,
			chromePid: chrome.pid,
			chromePort: chrome.port,
			userDataDir,
		};
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		stopThinkingMonitor?.();
		const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
		connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
		if (!socketClosed) {
			logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
			if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
				logger(normalizedError.stack);
			}
			throw normalizedError;
		}
		if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
			logger(`Chrome window closed before completion: ${normalizedError.message}`);
			logger(normalizedError.stack);
		}
		throw new Error(
			"Chrome window closed before Oracle finished. Please keep it open until completion.",
			{
				cause: normalizedError,
			},
		);
	} finally {
		try {
			await releaseBrowserLock?.();
		} catch {
			// ignore lock release failures
		}
		try {
			if (!connectionClosedUnexpectedly) {
				await client?.close();
			}
		} catch {
			// ignore
		}
		removeTerminationHooks?.();
		if (!config.keepBrowser) {
			if (!connectionClosedUnexpectedly) {
				try {
					await chrome.kill();
				} catch {
					// ignore kill failures
				}
			}
			await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
			if (!connectionClosedUnexpectedly) {
				const totalSeconds = (Date.now() - startedAt) / 1000;
				logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
			}
		} else if (!connectionClosedUnexpectedly) {
			logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
		}
	}
}

export { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from "./config.js";
export { syncCookies } from "./cookies.js";
export {
	captureAssistantMarkdown,
	ensureModelSelection,
	ensureNotBlocked,
	ensurePromptReady,
	navigateToChatGPT,
	submitPrompt,
	uploadAttachmentFile,
	waitForAssistantResponse,
	waitForAttachmentCompletion,
} from "./pageActions.js";
export { estimateTokenCount } from "./utils.js";

function isWebSocketClosureError(error: Error): boolean {
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket connection closed") ||
		message.includes("websocket is closed") ||
		message.includes("websocket error") ||
		message.includes("target closed")
	);
}

export function formatThinkingLog(
	startedAt: number,
	now: number,
	message: string,
	locatorSuffix: string,
): string {
	const elapsedMs = now - startedAt;
	const elapsedText = formatElapsed(elapsedMs);
	const progress = Math.min(1, elapsedMs / 600_000); // soft target: 10 minutes
	const barSegments = 10;
	const filled = Math.round(progress * barSegments);
	const bar = `${"█".repeat(filled).padEnd(barSegments, "░")}`;
	const pct = Math.round(progress * 100)
		.toString()
		.padStart(3, " ");
	const statusLabel = message ? ` — ${message}` : "";
	return `[${elapsedText} / ~10m] ${bar} ${pct}%${statusLabel}${locatorSuffix}`;
}

function startThinkingStatusMonitor(
	Runtime: ChromeClient["Runtime"],
	logger: BrowserLogger,
	includeDiagnostics = false,
): () => void {
	let stopped = false;
	let pending = false;
	let lastMessage: string | null = null;
	const startedAt = Date.now();
	const interval = setInterval(async () => {
		// biome-ignore lint/nursery/noUnnecessaryConditions: stop flag flips asynchronously
		if (stopped || pending) {
			return;
		}
		pending = true;
		try {
			const nextMessage = await readThinkingStatus(Runtime);
			if (nextMessage && nextMessage !== lastMessage) {
				lastMessage = nextMessage;
				let locatorSuffix = "";
				if (includeDiagnostics) {
					try {
						const snapshot = await readAssistantSnapshot(Runtime);
						locatorSuffix = ` | assistant-turn=${snapshot ? "present" : "missing"}`;
					} catch {
						locatorSuffix = " | assistant-turn=error";
					}
				}
				logger(formatThinkingLog(startedAt, Date.now(), nextMessage, locatorSuffix));
			}
		} catch {
			// ignore DOM polling errors
		} finally {
			pending = false;
		}
	}, 1500);
	interval.unref?.();
	return () => {
		// biome-ignore lint/nursery/noUnnecessaryConditions: multiple callers may race to stop
		if (stopped) {
			return;
		}
		stopped = true;
		clearInterval(interval);
	};
}

async function readThinkingStatus(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
	const expression = buildThinkingStatusExpression();
	try {
		const { result } = await Runtime.evaluate({ expression, returnByValue: true });
		const value = typeof result.value === "string" ? result.value.trim() : "";
		const sanitized = sanitizeThinkingText(value);
		return sanitized || null;
	} catch {
		return null;
	}
}

function sanitizeThinkingText(raw: string): string {
	if (!raw) {
		return "";
	}
	const trimmed = raw.trim();
	const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
	if (prefixPattern.test(trimmed)) {
		return trimmed.replace(prefixPattern, "").trim();
	}
	return trimmed;
}

function buildThinkingStatusExpression(): string {
	const selectors = [
		"span.loading-shimmer",
		"span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary",
		'[data-testid*="thinking"]',
		'[data-testid*="reasoning"]',
		'[role="status"]',
		'[aria-live="polite"]',
	];
	const keywords = [
		"pro thinking",
		"thinking",
		"reasoning",
		"clarifying",
		"planning",
		"drafting",
		"summarizing",
	];
	const selectorLiteral = JSON.stringify(selectors);
	const keywordsLiteral = JSON.stringify(keywords);
	return `(() => {
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    document.querySelectorAll('[data-testid]').forEach((node) => nodes.add(node));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = (node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        const shimmerChild = node.querySelector(
          'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
        );
        if (shimmerChild?.textContent?.trim()) {
          return shimmerChild.textContent.trim();
        }
        return text.trim();
      }
    }
    return null;
  })()`;
}
