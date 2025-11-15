import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch, type LaunchedChrome } from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import type Protocol from 'devtools-protocol';

type ChromeClient = Awaited<ReturnType<typeof CDP>>;
type CookieParam = Protocol.Network.CookieParam;
type ChromeCookiesSecureModule = {
  getCookiesPromised: (
    url: string,
    format: 'puppeteer' | 'object',
    profile?: string
  ) => Promise<PuppeteerCookie[] | Record<string, unknown>>;
};

type PuppeteerCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  Secure?: boolean;
  HttpOnly?: boolean;
};

export interface BrowserAutomationConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  url?: string;
  timeoutMs?: number;
  inputTimeoutMs?: number;
  cookieSync?: boolean;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  debug?: boolean;
}

export interface BrowserRunOptions {
  prompt: string;
  config?: BrowserAutomationConfig;
  log?: (message: string) => void;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  chromePid?: number;
  chromePort?: number;
  userDataDir?: string;
}

type BrowserLogger = (message: string) => void;

export const CHATGPT_URL = 'https://chatgpt.com/';
export const DEFAULT_MODEL_TARGET = 'ChatGPT 5.1';
const COOKIE_URLS = ['https://chatgpt.com', 'https://chat.openai.com'];
// Multiple selectors are required because ChatGPT frequently swaps out editor implementations.
const INPUT_SELECTORS = [
  'textarea[data-id="prompt-textarea"]',
  'textarea[placeholder*="Send a message"]',
  'textarea[aria-label="Message ChatGPT"]',
  'textarea:not([disabled])',
  'textarea[name="prompt-textarea"]',
  '#prompt-textarea',
  '.ProseMirror',
  '[contenteditable="true"][data-virtualkeyboard="true"]',
];
// The assistant bubbles moved around several times, so we try the newest selectors first and
// fall back to the legacy combinations that still show up for some users.
const ANSWER_SELECTORS = [
  'article[data-testid^="conversation-turn"][data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"] .markdown',
  '[data-message-author-role="assistant"] .markdown',
  '[data-message-author-role="assistant"]',
];
const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
const MODEL_BUTTON_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
const COPY_BUTTON_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
const execFileAsync = promisify(execFile);

type ResolvedBrowserConfig = Required<
  Omit<BrowserAutomationConfig, 'chromeProfile' | 'chromePath' | 'desiredModel'>
> & {
  chromeProfile?: string | null;
  chromePath?: string | null;
  desiredModel?: string | null;
};

const DEFAULT_BROWSER_CONFIG: ResolvedBrowserConfig = {
  chromeProfile: null,
  chromePath: null,
  url: CHATGPT_URL,
  timeoutMs: 900_000,
  inputTimeoutMs: 30_000,
  cookieSync: true,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  desiredModel: DEFAULT_MODEL_TARGET,
  debug: false,
};

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required when using browser mode.');
  }

  const config: ResolvedBrowserConfig = {
    ...DEFAULT_BROWSER_CONFIG,
    ...(options.config ?? {}),
    url: options.config?.url ?? DEFAULT_BROWSER_CONFIG.url,
    timeoutMs: options.config?.timeoutMs ?? DEFAULT_BROWSER_CONFIG.timeoutMs,
    inputTimeoutMs: options.config?.inputTimeoutMs ?? DEFAULT_BROWSER_CONFIG.inputTimeoutMs,
    cookieSync: options.config?.cookieSync ?? DEFAULT_BROWSER_CONFIG.cookieSync,
    headless: options.config?.headless ?? DEFAULT_BROWSER_CONFIG.headless,
    keepBrowser: options.config?.keepBrowser ?? DEFAULT_BROWSER_CONFIG.keepBrowser,
    hideWindow: options.config?.hideWindow ?? DEFAULT_BROWSER_CONFIG.hideWindow,
    desiredModel: options.config?.desiredModel ?? DEFAULT_BROWSER_CONFIG.desiredModel,
    chromeProfile: options.config?.chromeProfile ?? DEFAULT_BROWSER_CONFIG.chromeProfile,
    chromePath: options.config?.chromePath ?? DEFAULT_BROWSER_CONFIG.chromePath,
    debug: options.config?.debug ?? DEFAULT_BROWSER_CONFIG.debug,
  };

  const logger: BrowserLogger = options.log ?? (() => {});
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-browser-'));
  logger(`Created temporary Chrome profile at ${userDataDir}`);

  const chrome = await launchChrome(config, userDataDir, logger);
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, config.keepBrowser, logger);
  } catch {
    // Ignore hook failures; normal cleanup will handle shutdown.
  }

  let client: ChromeClient | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerHtml = '';
  let answerMarkdown = '';
  let runSuccessful = false;

  try {
    client = await connectToChrome(chrome.port, logger);
    const { Network, Page, Runtime, Input } = client;

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    await Promise.all([Network.enable({}), Page.enable(), Runtime.enable()]);
    await Network.clearBrowserCookies();

    if (config.cookieSync) {
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger);
      logger(
        cookieCount > 0
          ? `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? 'Default'}`
          : 'No Chrome cookies found; continuing without session reuse',
      );
    } else {
      logger('Skipping Chrome cookie sync (--browser-no-cookie-sync)');
    }

    await navigateToChatGPT(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    if (config.desiredModel) {
      await ensureModelSelection(Runtime, config.desiredModel, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    }
    await submitPrompt({ Runtime, Input }, promptText, logger);
    const answer = await waitForAssistantResponse(Runtime, config.timeoutMs, logger);
    answerText = answer.text;
    answerHtml = answer.html ?? '';
    const copiedMarkdown = await captureAssistantMarkdown(Runtime, answer.meta, logger);
    if (copiedMarkdown) {
      answerMarkdown = copiedMarkdown;
      logger('Captured markdown via ChatGPT copy button');
    } else {
      answerMarkdown = answerText;
    }
    runSuccessful = true;
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown || answerText);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml || undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      userDataDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to complete ChatGPT run: ${message}`);
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && error instanceof Error && error.stack) {
      logger(error.stack);
    }
    throw error;
  } finally {
    try {
      await client?.close();
    } catch {
      // ignore close failures
    }
    removeTerminationHooks?.();
    if (!config.keepBrowser) {
      try {
        chrome.kill();
      } catch {
        // ignore kill failures
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      const totalSeconds = (Date.now() - startedAt) / 1000;
      logger(`Cleanup ${runSuccessful ? 'complete' : 'attempted'} • ${totalSeconds.toFixed(1)}s total`);
    } else {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

export function parseDuration(input: string, fallback: number): number {
  if (!input) return fallback;
  const match = /^([0-9]+)(ms|s|m)?$/i.exec(input.trim());
  if (!match) {
    return fallback;
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!unit || unit === 'ms') {
    return value;
  }
  if (unit === 's') {
    return value * 1000;
  }
  if (unit === 'm') {
    return value * 60_000;
  }
  return fallback;
}

async function launchChrome(config: ResolvedBrowserConfig, userDataDir: string, logger: BrowserLogger): Promise<LaunchedChrome> {
  const chromeFlags = buildChromeFlags(config.headless);
  const launcher = await launch({
    chromePath: config.chromePath ?? undefined,
    chromeFlags,
    userDataDir,
  });
  const pidLabel = typeof launcher.pid === 'number' ? ` (pid ${launcher.pid})` : '';
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}`);
  return launcher;
}

function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: (msg: string) => void
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  let handling = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    logger(`Received ${signal}; terminating Chrome process`);
    void (async () => {
      try {
        await chrome.kill();
      } catch {
        // ignore kill failures
      }
      if (!keepBrowser) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    })().finally(() => {
      const exitCode = signal === 'SIGINT' ? 130 : 1;
      process.exit(exitCode);
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

function buildChromeFlags(headless: boolean): string[] {
  const flags = [
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--disable-features=TranslateUI,AutomationControlled',
    '--mute-audio',
    '--window-size=1280,720',
    '--password-store=basic',
    '--use-mock-keychain',
  ];

  if (headless) {
    flags.push('--headless=new');
  }

  return flags;
}

async function connectToChrome(port: number, logger: (msg: string) => void): Promise<ChromeClient> {
  const client = await CDP({ port });
  logger('Connected to Chrome DevTools protocol');
  return client;
}

// Cookie reuse saves us from logging into the temp profile; we read cookies from the main Chrome
// profile and replay them through the DevTools protocol so the new browser session becomes trusted.
async function syncCookies(
  Network: ChromeClient['Network'],
  url: string,
  profile: string | null | undefined,
  logger: (msg: string) => void
) {
  try {
    const cookies = await readChromeCookies(url, profile);
    if (!cookies.length) {
      return 0;
    }
    let applied = 0;
    for (const cookie of cookies) {
      const cookieWithUrl: CookieParam = { ...cookie };
      if (!cookieWithUrl.domain || cookieWithUrl.domain === 'localhost') {
        cookieWithUrl.url = url;
      } else if (!cookieWithUrl.domain.startsWith('.')) {
        cookieWithUrl.url = `https://${cookieWithUrl.domain}`;
      }
      try {
        const result = await Network.setCookie(cookieWithUrl);
        if (result?.success) {
          applied += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to set cookie ${cookie.name}: ${message}`);
      }
    }
    return applied;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Cookie sync failed: ${message}`);
    return 0;
  }
}

async function readChromeCookies(url: string, profile?: string | null): Promise<CookieParam[]> {
  const moduleCandidate: any = await import('chrome-cookies-secure');
  const chromeModule: ChromeCookiesSecureModule | undefined =
    moduleCandidate && typeof moduleCandidate.getCookiesPromised === 'function'
      ? moduleCandidate
      : moduleCandidate?.default;
  if (!chromeModule?.getCookiesPromised) {
    throw new Error('chrome-cookies-secure did not expose getCookiesPromised');
  }
  const urlsToCheck = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const merged = new Map<string, CookieParam>();
  for (const candidateUrl of urlsToCheck) {
    let rawCookies: unknown;
    try {
      rawCookies = await chromeModule.getCookiesPromised(candidateUrl, 'puppeteer', profile ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[chatgpt-devtools] Failed to read cookies for ${candidateUrl}: ${message}`);
      continue;
    }
    if (!Array.isArray(rawCookies)) {
      continue;
    }
    const fallbackHostname = new URL(candidateUrl).hostname;
    for (const cookie of rawCookies) {
      const normalized = normalizeCookie(cookie, fallbackHostname);
      if (!normalized) {
        continue;
      }
      const key = `${normalized.domain ?? fallbackHostname}:${normalized.name}`;
      if (!merged.has(key)) {
        merged.set(key, normalized);
      }
    }
  }
  return Array.from(merged.values());
}

function normalizeCookie(cookie: PuppeteerCookie, fallbackHost: string): CookieParam | null {
  if (!cookie?.name) {
    return null;
  }

  const domain = cookie.domain?.startsWith('.') ? cookie.domain : cookie.domain ?? fallbackHost;
  const expires = normalizeExpiration(cookie.expires);
  const secure = typeof cookie.Secure === 'boolean' ? cookie.Secure : true;
  const httpOnly = typeof cookie.HttpOnly === 'boolean' ? cookie.HttpOnly : false;

  return {
    name: cookie.name,
    value: cookie.value ?? '',
    domain,
    path: cookie.path ?? '/',
    expires,
    secure,
    httpOnly,
  } satisfies CookieParam;
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeExpiration(expires?: number): number | undefined {
  if (!expires || Number.isNaN(expires)) {
    return undefined;
  }
  const value = Number(expires);
  if (value <= 0) {
    return undefined;
  }
  if (value > 1_000_000_000_000) {
    return Math.round(value / 1_000_000 - 11644473600);
  }
  if (value > 1_000_000_000) {
    return Math.round(value / 1000);
  }
  return Math.round(value);
}

async function navigateToChatGPT(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: (msg: string) => void
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

async function ensureNotBlocked(Runtime: ChromeClient['Runtime'], headless: boolean, logger: (msg: string) => void) {
  if (await isCloudflareInterstitial(Runtime)) {
    // In headless mode the page is unsalvageable (CF blocks DevTools); force the caller to try headful.
    const message = headless
      ? 'Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge.'
      : 'Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.';
    logger('Cloudflare anti-bot page detected');
    throw new Error(message);
  }
}

async function isCloudflareInterstitial(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const title = typeof titleResult.value === 'string' ? titleResult.value : '';
  if (title.toLowerCase().includes('just a moment')) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('script[src*="/challenge-platform/"]'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({ expression: 'document.readyState', returnByValue: true });
    if (result.value === 'interactive' || result.value === 'complete') {
      if (result.value === 'complete') {
        return;
      }
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for document readiness');
}

async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: (msg: string) => void) {
  const selector = await waitForSelector(Runtime, INPUT_SELECTORS, timeoutMs);
  logger(`Found prompt textarea via selector ${selector}`);
}

async function ensureModelSelection(Runtime: ChromeClient['Runtime'], targetModel: string, logger: (msg: string) => void) {
  const outcome = await Runtime.evaluate({
    expression: buildModelGuardExpression(targetModel),
    awaitPromise: true,
    returnByValue: true,
  });

  const result = outcome.result.value as
    | { status: 'already-selected'; label?: string | null }
    | { status: 'switched'; label?: string | null }
    | { status: 'option-not-found' }
    | { status: 'button-missing' };

  // Keep the switch tiny so errors point to the right remediation (e.g., user passed a typo).
  switch (result?.status) {
    case 'already-selected': {
      logger(`Model already set to ${result.label ?? targetModel}`);
      return;
    }
    case 'switched': {
      logger(`Switched model to ${result.label ?? targetModel}`);
      return;
    }
    case 'option-not-found': {
      throw new Error(`Unable to find model option matching "${targetModel}" in the model switcher.`);
    }
    case 'button-missing':
    default: {
      throw new Error('Unable to locate the ChatGPT model selector button.');
    }
  }
}

async function waitForSelector(Runtime: ChromeClient['Runtime'], selectors: string[], timeoutMs: number): Promise<string> {
  const start = Date.now();
  const selectorLiteral = JSON.stringify(selectors);
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const candidates = ${selectorLiteral};
        for (const selector of candidates) {
          if (document.querySelector(selector)) {
            return selector;
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });
    if (result.value) {
      return result.value as string;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for selectors: ${selectors.join(', ')}`);
}

async function submitPrompt(
  client: { Runtime: ChromeClient['Runtime']; Input: ChromeClient['Input'] },
  prompt: string,
  logger: (msg: string) => void
) {
  const { Runtime, Input } = client;
  logger('Submitting prompt to ChatGPT');
  const encodedPrompt = JSON.stringify(prompt);
const focusExpression = `(() => {
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const dispatchPointer = (target) => {
        if (!(target instanceof HTMLElement)) {
          return;
        }
        // Some parts of the composer refuse to focus unless they receive a real pointer sequence.
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        dispatchPointer(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (!node) continue;
        if (focusNode(node)) {
          return { focused: true };
        }
      }
      return { focused: false };
    })()`;

  const evaluation = await Runtime.evaluate({
    expression: focusExpression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (evaluation.exceptionDetails) {
    const description = evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text ?? 'Unknown eval error';
    throw new Error(`Failed to focus prompt textarea: ${description}`);
  }

  const focused = Boolean(evaluation.result?.value?.focused);
  if (!focused) {
    throw new Error('Failed to focus prompt textarea');
  }

  await Input.insertText({ text: prompt });

  // The composer mirrors text into both a contenteditable div and a hidden textarea; capture both.
  const verification = await Runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector('#prompt-textarea');
      const fallback = document.querySelector('textarea[name="prompt-textarea"]');
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
      };
    })()`,
    returnByValue: true,
  });

  const editorText = verification.result?.value?.editorText?.trim?.() ?? '';
  const fallbackValue = verification.result?.value?.fallbackValue?.trim?.() ?? '';
  if (!editorText && !fallbackValue) {
    await Runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector('textarea[name="prompt-textarea"]');
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector('#prompt-textarea');
        if (editor) {
          editor.textContent = ${encodedPrompt};
        }
      })()`,
    });
  }

  const clicked = await attemptSendButton(Runtime);
  if (!clicked) {
    await Input.dispatchKeyEvent({
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    logger('Submitted prompt via Enter key');
  } else {
    logger('Clicked send button');
  }

  await verifyPromptCommitted(Runtime, prompt, 30_000);
}

// ChatGPT sometimes ignores synthetic send events; we poll the conversation DOM so we can fail fast
// rather than waiting for the final timeout.
async function verifyPromptCommitted(Runtime: ChromeClient['Runtime'], prompt: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  // Poll the conversation DOM until the user bubble (article turn) contains our prompt.
  const script = `(() => {
    const editor = document.querySelector('#prompt-textarea');
    const fallback = document.querySelector('textarea[name="prompt-textarea"]');
    const normalizedPrompt = ${encodedPrompt}.toLowerCase();
    const articles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    const userMatched = articles.some((node) => node?.innerText?.toLowerCase().includes(normalizedPrompt));
    return {
      userMatched,
      fallbackValue: fallback?.value ?? '',
      editorValue: editor?.innerText ?? '',
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as { userMatched: boolean };
    if (info?.userMatched) {
      return;
    }
    await delay(100);
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}

async function attemptSendButton(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const script = `(() => {
    const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
    if (!button) {
      return 'missing';
    }
    const ariaDisabled = button.getAttribute('aria-disabled');
    const disabled = button.hasAttribute('disabled') || ariaDisabled === 'true';
    if (disabled || window.getComputedStyle(button).display === 'none') {
      return 'disabled';
    }
    button.click();
    return 'clicked';
  })()`; // evaluated repeatedly via Runtime until the UI acknowledges the click

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === 'clicked') {
      return true;
    }
    if (result.value === 'missing') {
      break;
    }
    await delay(100);
  }
  return false;
}

async function waitForSendButton(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<'clicked' | 'timeout'> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
        if (!button) {
          return 'missing';
        }
        const ariaDisabled = button.getAttribute('aria-disabled');
        const disabled = button.hasAttribute('disabled') || ariaDisabled === 'true';
        if (!disabled) {
          button.click();
          return 'clicked';
        }
        return 'disabled';
      })()`,
      returnByValue: true,
    });

    if (result?.value === 'clicked') {
      return 'clicked';
    }

    await delay(150);
  }
  return 'timeout';
}

interface AssistantResponseMeta {
  messageId?: string | null;
  turnId?: string | null;
}

async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: (msg: string) => void
): Promise<{ text: string; html?: string; meta: AssistantResponseMeta }> {
  logger('Waiting for ChatGPT response');
  const expression = buildResponseObserverExpression(timeoutMs);
  let evaluation;
  try {
    evaluation = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  } catch (error) {
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    throw error;
  }
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const html = typeof (result.value as { html?: unknown }).html === 'string' ? ((result.value as { html?: string }).html ?? undefined) : undefined;
    const turnId = typeof (result.value as { turnId?: unknown }).turnId === 'string' ? ((result.value as { turnId?: string }).turnId ?? undefined) : undefined;
    const messageId = typeof (result.value as { messageId?: unknown }).messageId === 'string' ? ((result.value as { messageId?: string }).messageId ?? undefined) : undefined;
    return {
      text: String((result.value as { text: unknown }).text ?? ''),
      html,
      meta: { turnId, messageId },
    };
  }
  const fallbackText = typeof result.value === 'string' ? (result.value as string) : '';
  if (!fallbackText) {
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    throw new Error('Unable to capture assistant response');
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function logConversationSnapshot(Runtime: ChromeClient['Runtime'], logger: (msg: string) => void) {
  const debugExpression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression: debugExpression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

function buildResponseObserverExpression(timeoutMs: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  // We inline the logic so it executes inside the page context where MutationObserver is available.
  return `(() => {
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const CONVERSATION_SELECTOR = 'article[data-testid^="conversation-turn"]';

    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = node.getAttribute('data-testid') || '';
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector('[data-message-author-role="assistant"], [data-testid*="assistant"]'));
    };

    const extractFromTurns = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (!isAssistantTurn(turn)) {
          continue;
        }
        const messageRoot = turn.querySelector('[data-message-author-role="assistant"]') ?? turn;
        const preferred =
          messageRoot.querySelector('.markdown') ||
          messageRoot.querySelector('[data-message-author-role="assistant"]') ||
          messageRoot;
        const text = preferred?.innerText?.trim();
        if (text) {
          const turnId = turn.getAttribute('data-testid') || null;
          const messageId = messageRoot.getAttribute('data-message-id') || messageRoot.dataset?.messageId || null;
          return { text, html: preferred.innerHTML, turnId, messageId };
        }
      }
      return null;
    };

    const extractLegacy = () => {
      for (const selector of SELECTORS) {
        const nodes = document.querySelectorAll(selector);
        if (nodes.length === 0) {
          continue;
        }
        const target = nodes[nodes.length - 1];
        if (!target) continue;
        const text = target.innerText?.trim();
        if (text) {
          const article = target.closest(CONVERSATION_SELECTOR);
          const turnId = article?.getAttribute('data-testid') || null;
          const assistant = article?.querySelector('[data-message-author-role="assistant"]');
          const messageId = assistant?.getAttribute('data-message-id') || assistant?.dataset?.messageId || null;
          return { text, html: target.innerHTML, turnId, messageId };
        }
      }
      return null;
    };

    const stopButtonVisible = () => {
      const button = document.querySelector(STOP_SELECTOR);
      if (!button) {
        return false;
      }
      const hasHiddenAttr = button.hasAttribute('hidden');
      const style = window.getComputedStyle(button);
      const visuallyHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return !(hasHiddenAttr || visuallyHidden);
    };
    const extract = () => extractFromTurns() ?? extractLegacy();
    const ready = () => {
      const latest = extract();
      if (latest && !stopButtonVisible()) {
        return latest;
      }
      return null;
    };

    return new Promise((resolve, reject) => {
      const initial = ready();
      if (initial) {
        resolve(initial);
        return;
      }
      const observer = new MutationObserver(() => {
        const result = ready();
        if (result) {
          cleanup();
          resolve(result);
        }
      });
      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timer);
      };
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => {
        cleanup();
        const fallback = extract();
        if (fallback) {
          resolve(fallback);
        } else {
          reject(new Error('Timed out waiting for assistant response'));
        }
      }, ${timeoutMs});
    });
  })()`;
}

function buildConversationDebugExpression(): string {
  return `(() => {
    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    return turns.map((node) => ({
      testId: node.getAttribute('data-testid') || null,
      role: node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || null,
      text: (node.innerText || '').trim().slice(0, 280),
      htmlSnippet: (node.innerHTML || '').trim().slice(0, 5000),
    }));
  })()`;
}

async function captureAssistantMarkdown(
  Runtime: ChromeClient['Runtime'],
  meta: AssistantResponseMeta,
  logger: (msg: string) => void
): Promise<string | undefined> {
  const expression = buildCopyMarkdownExpression(meta);
  try {
    const { result } = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    const value = result.value as { success?: boolean; markdown?: string; error?: string } | null;
    if (value?.success && typeof value.markdown === 'string' && value.markdown.trim().length) {
      return value.markdown.trim();
    }
    if (value?.error) {
      logger(`Markdown capture failed: ${value.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Markdown capture threw: ${message}`);
  }
  return undefined;
}

function buildCopyMarkdownExpression(meta: AssistantResponseMeta): string {
  const turnLiteral = JSON.stringify(meta.turnId ?? null);
  const messageLiteral = JSON.stringify(meta.messageId ?? null);
  return `(() => {
    const TARGET_TURN = ${turnLiteral};
    const TARGET_MESSAGE = ${messageLiteral};
    const COPY_SELECTOR = '${COPY_BUTTON_SELECTOR}';

    const findButton = () => {
      if (TARGET_TURN) {
        const article = document.querySelector('article[data-testid="' + TARGET_TURN + '"]');
        const btn = article?.querySelector(COPY_SELECTOR);
        if (btn) return btn;
      }
      if (TARGET_MESSAGE) {
        const node = document.querySelector('[data-message-id="' + TARGET_MESSAGE + '"]');
        const article = node?.closest('article[data-testid^="conversation-turn"]');
        const btn = article?.querySelector(COPY_SELECTOR);
        if (btn) return btn;
      }
      const articles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
      for (let i = articles.length - 1; i >= 0; i -= 1) {
        const article = articles[i];
        if (article.getAttribute('data-turn') === 'assistant' || article.querySelector('[data-message-author-role="assistant"]')) {
          const btn = article.querySelector(COPY_SELECTOR);
          if (btn) return btn;
        }
      }
      return null;
    };

    return new Promise((resolve) => {
      const button = findButton();
      if (!button) {
        resolve({ success: false, error: 'copy button not found' });
        return;
      }
      const clip = navigator.clipboard;
      if (!clip || typeof clip.write !== 'function') {
        resolve({ success: false, error: 'clipboard.write unavailable' });
        return;
      }
      const original = clip.write.bind(clip);
      const finish = (result) => {
        clip.write = original;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ success: false, error: 'copy timeout' }), 3000);
      clip.write = async (items) => {
        const payloads = [];
        if (Array.isArray(items)) {
          for (const item of items) {
            const entry = { types: Array.from(item.types) };
            for (const type of item.types) {
              try {
                const blob = await item.getType(type);
                entry[type] = await blob.text();
              } catch (error) {
                entry[type] = 'error:' + (error?.message ?? error);
              }
            }
            payloads.push(entry);
          }
        }
        const markdown =
          payloads.find((entry) => typeof entry['text/markdown'] === 'string')?.['text/markdown'] ??
          payloads.find((entry) => typeof entry['text/plain'] === 'string')?.['text/plain'] ??
          '';
        finish({ success: Boolean(markdown.trim()), markdown, payloads });
        return Promise.resolve();
      };
      try {
        button.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {}
      button.click();
    });
  })()`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// macOS can "hide" apps (Cmd-H) which is less jarring than minimizing; we use AppleScript to target
// the specific Chrome process we launched so we don't accidentally hide the user's real browser.
async function hideChromeWindow(chrome: LaunchedChrome, logger: (msg: string) => void) {
  if (process.platform !== 'darwin') {
    logger('Window hiding is only supported on macOS');
    return;
  }
  if (!chrome.pid) {
    logger('Unable to hide window: missing Chrome PID');
    return;
  }
  const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
  try {
    await execFileAsync('osascript', ['-e', script]);
    logger('Chrome window hidden (Cmd-H)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to hide Chrome window: ${message}`);
  }
}

// This runs inside the page to drive the floating model selector, matching either the human-readable
// label or the internal data-testid identifiers that OpenAI uses. Keeping it here avoids any flakiness
// from waiting for repeated round-trips between Node and the browser.
function buildModelGuardExpression(targetModel: string): string {
  const { labelTokens, testIdTokens } = buildModelMatchers(targetModel);
  const labelLiteral = JSON.stringify(labelTokens);
  const idLiteral = JSON.stringify(testIdTokens);
  return `(() => {
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const CLICK_INTERVAL_MS = 50;
    const MAX_WAIT_MS = 12000;

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }

    const pointerClick = () => {
      const down = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const up = new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const click = new MouseEvent('click', { bubbles: true });
      button.dispatchEvent(down);
      button.dispatchEvent(up);
      button.dispatchEvent(click);
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };

    const findOption = () => {
      const menus = Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root]'));
      for (const menu of menus) {
        const buttons = Array.from(
          menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]')
        );
        for (const option of buttons) {
          const testid = (option.getAttribute('data-testid') ?? '').toLowerCase();
          const text = option.textContent?.toLowerCase() ?? '';
          const matchesTestId = testid && TEST_IDS.some((id) => testid.includes(id));
          const matchesText = LABEL_TOKENS.some((token) => text.includes(token));
          if (matchesTestId || matchesText) {
            return option;
          }
        }
      }
      return null;
    };

    pointerClick();
    return new Promise((resolve) => {
      const start = performance.now();
      const attempt = () => {
        const option = findOption();
        if (option) {
          if (optionIsSelected(option)) {
            resolve({ status: 'already-selected', label: getOptionLabel(option) });
            return;
          }
          option.click();
          resolve({ status: 'switched', label: getOptionLabel(option) });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({ status: 'option-not-found' });
          return;
        }
        setTimeout(attempt, CLICK_INTERVAL_MS);
      };
      attempt();
    });
  })()`;
}

function buildModelMatchers(targetModel: string): { labelTokens: string[]; testIdTokens: string[] } {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, ' '), labelTokens);
  const collapsed = base.replace(/\s+/g, '');
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, '');
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);

  const hyphenated = base.replace(/\s+/g, '-');
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, '-'));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  const estimate = Math.max(words.length * 0.75, text.length / 4);
  return Math.max(1, Math.round(estimate));
}
