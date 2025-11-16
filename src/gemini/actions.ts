import type { ChromeClient, BrowserLogger } from '../browser/types.js';
import { delay } from '../browser/utils.js';
import { GEMINI_INPUT_SELECTORS, GEMINI_SEND_BUTTON_SELECTORS } from './constants.js';

export async function navigateToGemini(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to Gemini at ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export async function ensureGeminiPromptReady(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
) {
  const ready = await waitForGeminiPrompt(Runtime, timeoutMs);
  if (!ready) {
    logger('Gemini prompt textarea did not appear before timeout');
    throw new Error('Gemini prompt input did not appear before timeout');
  }
  logger('Gemini prompt ready');
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Gemini page did not reach ready state in time');
}

async function waitForGeminiPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const selectorLiteral = JSON.stringify(GEMINI_INPUT_SELECTORS);
  const script = `(() => {
    const selectors = ${selectorLiteral};
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        return true;
      }
    }
    return false;
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

export async function submitGeminiPrompt(
  Runtime: ChromeClient['Runtime'],
  prompt: string,
  logger: BrowserLogger,
) {
  const encodedPrompt = JSON.stringify(prompt);
  const selectorLiteral = JSON.stringify(GEMINI_INPUT_SELECTORS);
  const buttonSelectorLiteral = JSON.stringify(GEMINI_SEND_BUTTON_SELECTORS);
  const expression = `(() => {
    const inputSelectors = ${selectorLiteral};
    const buttonSelectors = ${buttonSelectorLiteral};
    const text = ${encodedPrompt};

    const setText = (node) => {
      if (!node) return false;
      if (node instanceof HTMLTextAreaElement) {
        node.value = text;
      } else {
        node.textContent = text;
      }
      const event = new Event('input', { bubbles: true });
      node.dispatchEvent(event);
      return true;
    };

    let inputNode = null;
    for (const selector of inputSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && setText(candidate)) {
        inputNode = candidate;
        break;
      }
    }
    if (!inputNode) {
      return { success: false, status: 'input-missing' };
    }

    for (const selector of buttonSelectors) {
      const button = document.querySelector(selector);
      if (button instanceof HTMLButtonElement && !button.disabled) {
        button.click();
        return { success: true, status: 'clicked' };
      }
    }

    // Fallback: press Enter in the focused element
    const active = document.activeElement;
    if (active && active !== document.body) {
      const keyboardEventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' };
      active.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
      active.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));
      return { success: true, status: 'enter' };
    }

    return { success: false, status: 'send-missing' };
  })()`;

  const { result } = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  const status = result?.value?.status;
  if (!result?.value?.success) {
    logger(`Gemini prompt submission status: ${status ?? 'unknown'}`);
    throw new Error('Failed to submit prompt to Gemini.');
  }
  logger(`Submitted Gemini prompt via ${status === 'clicked' ? 'send button' : 'Enter key'}`);
}

export async function waitForGeminiResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<string> {
  logger('Waiting for Gemini response');
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableCycles = 0;
  const requiredStableCycles = 6;

  const expression = buildGeminiResponseExtractorExpression();

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const text = typeof result?.value === 'string' ? result.value.trim() : '';
    if (text && text !== lastText) {
      lastText = text;
      stableCycles = 0;
    } else if (text) {
      stableCycles += 1;
    } else {
      stableCycles = 0;
    }
    if (text && stableCycles >= requiredStableCycles) {
      return text;
    }
    await delay(400);
  }
  if (lastText) {
    logger('Gemini response watchdog timeout; returning latest captured text.');
    return lastText;
  }
  throw new Error('Timed out waiting for Gemini response.');
}

function buildGeminiResponseExtractorExpression(): string {
  return `(() => {
    const host = document.querySelector('chat-app') || document;
    const candidates = [];

    const pushText = (node) => {
      if (!node) return;
      const text = node.innerText || node.textContent || '';
      const normalized = text.trim();
      if (normalized.length > 0) {
        candidates.push(normalized);
      }
    };

    host.querySelectorAll('[data-message-author-role], main article, main div[role="article"], main section').forEach((node) => {
      pushText(node);
    });

    if (candidates.length === 0) {
      const main = host.querySelector('main');
      if (main) {
        pushText(main);
      }
    }

    return candidates[candidates.length - 1] || '';
  })()`;
}

