import path from "node:path";
import {
	FILE_INPUT_SELECTOR,
	GENERIC_FILE_INPUT_SELECTOR,
	SEND_BUTTON_SELECTOR,
	UPLOAD_STATUS_SELECTORS,
	CONVERSATION_TURN_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import {
	getCurrentConversationUrl,
	loadSessionState,
	navigateToSavedSession,
} from "../sessionRecovery.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "../types.js";
import { delay } from "../utils.js";

export async function uploadAttachmentFile(
	deps: { runtime: ChromeClient["Runtime"]; dom?: ChromeClient["DOM"] },
	attachment: BrowserAttachment,
	logger: BrowserLogger,
) {
	const { runtime, dom } = deps;
	if (!dom) {
		throw new Error("DOM domain unavailable while uploading attachments.");
	}

	const selectors = [FILE_INPUT_SELECTOR, GENERIC_FILE_INPUT_SELECTOR];
	const maxAttempts = 3;
	const expectedName = path.basename(attachment.path);

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const documentNode = await dom.getDocument();
		let targetNodeId: number | undefined;
		for (const selector of selectors) {
			const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
			if (result.nodeId) {
				targetNodeId = result.nodeId;
				break;
			}
		}

		if (!targetNodeId) {
			lastError = new Error("Unable to locate ChatGPT file attachment input.");
		} else {
			try {
				await dom.setFileInputFiles({ nodeId: targetNodeId, files: [attachment.path] });
				const ready = await waitForAttachmentSelection(runtime, expectedName, 10_000);
				if (ready) {
					lastError = undefined;
					break;
				}
				lastError = new Error(
					"Attachment did not register with the ChatGPT composer in time (selection mismatch).",
				);
			} catch (error) {
				lastError = error;
				const message =
					error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
				if (message.includes("could not find node with given id") && attempt < maxAttempts) {
					logger(
						`Attachment input became stale while uploading (attempt ${attempt}); ` +
							"retrying file input lookup...",
					);
				} else {
					// Unexpected DevTools error; do not silently retry forever.
					break;
				}
			}
		}

		if (attempt < maxAttempts) {
			await delay(300 * attempt);
		}
	}

	if (lastError) {
		await logDomFailure(runtime, logger, "file-upload");
		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error(String(lastError));
	}

	// Wait additional time for ChatGPT to process the file and display the attachment UI
	// This addresses timing issues where the file is selected but not yet visually displayed
	await delay(2000);

	logger(`Attachment queued: ${attachment.displayPath}`);
}

export async function waitForAttachmentCompletion(
	Runtime: ChromeClient["Runtime"],
	timeoutMs: number,
	logger?: BrowserLogger,
	recoveryOptions?: {
		page: ChromeClient["Page"];
		userDataDir: string;
	} | null,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastUrl: string | undefined;

	const expression = `(() => {
    const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
    if (!button) {
      return { state: 'missing', uploading: false, url: window.location.href };
    }
    const disabled = button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const text = node.textContent?.toLowerCase?.() ?? '';
        return text.includes('upload') || text.includes('processing');
      });
    });
    return { state: disabled ? 'disabled' : 'ready', uploading, url: window.location.href };
  })()`;

	while (Date.now() < deadline) {
		try {
			const { result } = await Runtime.evaluate({ expression, returnByValue: true });
			const value = result?.value as
				| { state?: string; uploading?: boolean; url?: string }
				| undefined;

			// Detect page refresh/navigation
			if (lastUrl && value?.url && lastUrl !== value.url) {
				logger?.("Page refreshed or navigated during attachment upload.");

				// Attempt to recover the session
				if (recoveryOptions) {
					const session = await loadSessionState(recoveryOptions.userDataDir);
					if (session?.url) {
						logger?.(`Attempting to recover session from ${session.url}`);
						const recovered = await navigateToSavedSession(
							recoveryOptions.page,
							Runtime,
							session,
							logger ?? (() => {}),
						);

						if (recovered) {
							logger?.("Session recovered successfully. Waiting for page to stabilize...");
							await delay(2000); // Give extra time after recovery
							lastUrl = await getCurrentConversationUrl(Runtime);
							continue;
						} else {
							logger?.("Session recovery failed. Continuing with current page...");
						}
					}
				}

				await delay(1000); // Give page time to stabilize
				lastUrl = value.url;
				continue;
			}

			if (!lastUrl && value?.url) {
				lastUrl = value.url;
			}

			if (value && value.state === "ready" && !value.uploading) {
				// Double-check after a brief delay to ensure steady state
				await delay(500);
				const { result: confirmResult } = await Runtime.evaluate({
					expression,
					returnByValue: true,
				});
				const confirmValue = confirmResult?.value as
					| { state?: string; uploading?: boolean; url?: string }
					| undefined;

				if (
					confirmValue &&
					confirmValue.state === "ready" &&
					!confirmValue.uploading &&
					confirmValue.url === lastUrl
				) {
					// Triple-check that attachments are truly ready by verifying the DOM state
					await delay(1000); // Give extra time for any async operations
					const { result: finalCheck } = await Runtime.evaluate({
						expression,
						returnByValue: true,
					});
					const finalValue = finalCheck?.value as
						| { state?: string; uploading?: boolean; url?: string }
						| undefined;

					if (
						finalValue &&
						finalValue.state === "ready" &&
						!finalValue.uploading &&
						finalValue.url === lastUrl
					) {
						logger?.("Attachments uploaded successfully and confirmed in steady state");
						return;
					}
				}
			}
		} catch (error) {
			// Handle potential websocket or evaluation errors during refresh
			logger?.(
				`Error during attachment wait: ${error instanceof Error ? error.message : String(error)}`,
			);
			await delay(500);
		}

		await delay(250);
	}

	logger?.("Attachment upload timed out while waiting for ChatGPT composer to become ready.");
	await logDomFailure(Runtime, logger ?? (() => {}), "file-upload-timeout");
	throw new Error("Attachments did not finish uploading before timeout.");
}

async function waitForAttachmentSelection(
	Runtime: ChromeClient["Runtime"],
	expectedName: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const expression = `(() => {
    const selector = ${JSON.stringify(GENERIC_FILE_INPUT_SELECTOR)};
    const input = document.querySelector(selector);
    if (!input || !input.files) {
      return { matched: false, names: [] };
    }
    const names = Array.from(input.files).map((file) => file?.name ?? '');
    return { matched: names.some((name) => name === ${JSON.stringify(expectedName)}), names };
  })()`;
	while (Date.now() < deadline) {
		const { result } = await Runtime.evaluate({ expression, returnByValue: true });
		const matched = Boolean(result?.value?.matched);
		if (matched) {
			return true;
		}
		await delay(150);
	}
	return false;
}

export interface VisibleAttachment {
	filename: string;
	selector: string;
	outerHTML?: string;
}

export interface VerifyAttachmentsOptions {
	timeout?: number;
	pollInterval?: number;
}

/**
 * Verifies that attachments are visibly present in the ChatGPT composer DOM.
 * Returns the list of visible attachments found by querying various selectors.
 */
export async function verifyAttachmentsVisible(
	Runtime: ChromeClient["Runtime"],
	options: VerifyAttachmentsOptions = {},
	logger?: BrowserLogger,
): Promise<VisibleAttachment[]> {
	const timeout = options.timeout ?? 5000;
	const pollInterval = options.pollInterval ?? 200;
	const deadline = Date.now() + timeout;
	let lastSnapshotKey: string | null = null;
	let stableIterations = 0;

	const expression = `
    (() => {
      const SEND_BUTTON_SELECTOR = ${JSON.stringify(SEND_BUTTON_SELECTOR)};
      const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};

      const isElementVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
      };

      const ATTACHMENT_SELECTORS = [
        '[data-testid*="attachment-pill"]',
        'button[aria-label*="Remove attachment"]',
        '[data-testid*="file-attachment-container"]',
      ];

      // Scope detection to the active composer: we only want
      // attachments that are currently attached to the input area,
      // not historical files inside previous conversation turns.
      const sendButton = document.querySelector(SEND_BUTTON_SELECTOR);
      const composerRoot =
        (sendButton && (sendButton.closest('form') || sendButton.parentElement)) || document.body;

      const results = [];
      for (const selector of ATTACHMENT_SELECTORS) {
        document.querySelectorAll(selector).forEach((el) => {
          if (!composerRoot.contains(el)) return;
          if (el.closest(CONVERSATION_SELECTOR)) return;
          if (!isElementVisible(el)) return;

          let filename =
            el.getAttribute('aria-label')?.replace(/Remove attachment/i, '').trim() ||
            el.querySelector('[data-testid="file-attachment-name"]')?.textContent?.trim();

          if (filename) {
            results.push({
              filename,
              selector,
              outerHTML: el.outerHTML?.substring(0, 512) ?? '',
            });
          }
        });
      }
      return results;
    })()
  `;

	while (Date.now() < deadline) {
		try {
			const { result } = await Runtime.evaluate({ expression, returnByValue: true });
			const attachments = result?.value as VisibleAttachment[] | undefined;

			if (attachments && attachments.length > 0) {
				const snapshotKey = JSON.stringify(
					attachments.map((att) => `${att.filename}::${att.selector}`),
				);

				if (snapshotKey === lastSnapshotKey) {
					stableIterations += 1;
				} else {
					lastSnapshotKey = snapshotKey;
					stableIterations = 0;
				}

				if (stableIterations >= 2) {
					logger?.(
						`verifyAttachmentsVisible: detected ${attachments.length} visible attachment(s)`,
					);
					attachments.forEach((att, idx) => {
						logger?.(`  [${idx + 1}] ${att.filename} (matched: ${att.selector})`);
					});
					return attachments;
				}
			}
		} catch (error) {
			logger?.(
				`verifyAttachmentsVisible error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		await delay(pollInterval);
	}

	logger?.("verifyAttachmentsVisible: timeout reached, no attachments detected");
	return [];
}
