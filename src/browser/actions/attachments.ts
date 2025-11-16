import path from 'node:path';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import {
  FILE_INPUT_SELECTOR,
  GENERIC_FILE_INPUT_SELECTOR,
  SEND_BUTTON_SELECTOR,
  UPLOAD_STATUS_SELECTORS,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function uploadAttachmentFile(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
) {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }
  const documentNode = await dom.getDocument();
  const selectors = [FILE_INPUT_SELECTOR, GENERIC_FILE_INPUT_SELECTOR];
  let targetNodeId: number | undefined;
  for (const selector of selectors) {
    const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
    if (result.nodeId) {
      targetNodeId = result.nodeId;
      break;
    }
  }
  if (!targetNodeId) {
    await logDomFailure(runtime, logger, 'file-input');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }
  await dom.setFileInputFiles({ nodeId: targetNodeId, files: [attachment.path] });
  const expectedName = path.basename(attachment.path);
  const ready = await waitForAttachmentSelection(runtime, expectedName, 10_000);
  if (!ready) {
    await logDomFailure(runtime, logger, 'file-upload');
    throw new Error('Attachment did not register with the ChatGPT composer in time.');
  }
  logger(`Attachment queued: ${attachment.displayPath}`);
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger?: BrowserLogger,
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
      const value = result?.value as { state?: string; uploading?: boolean; url?: string } | undefined;

      // Detect page refresh/navigation
      if (lastUrl && value?.url && lastUrl !== value.url) {
        logger?.('Page refreshed or navigated during attachment upload. Waiting for steady state...');
        await delay(1000); // Give page time to stabilize
        lastUrl = value.url;
        continue;
      }

      if (!lastUrl && value?.url) {
        lastUrl = value.url;
      }

      if (value && value.state === 'ready' && !value.uploading) {
        // Double-check after a brief delay to ensure steady state
        await delay(500);
        const { result: confirmResult } = await Runtime.evaluate({ expression, returnByValue: true });
        const confirmValue = confirmResult?.value as { state?: string; uploading?: boolean; url?: string } | undefined;

        if (confirmValue && confirmValue.state === 'ready' && !confirmValue.uploading && confirmValue.url === lastUrl) {
          logger?.('Attachments uploaded successfully and page is in steady state');
          return;
        }
      }
    } catch (error) {
      // Handle potential websocket or evaluation errors during refresh
      logger?.(`Error during attachment wait: ${error instanceof Error ? error.message : String(error)}`);
      await delay(500);
    }

    await delay(250);
  }

  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'file-upload-timeout');
  throw new Error('Attachments did not finish uploading before timeout.');
}

async function waitForAttachmentSelection(
  Runtime: ChromeClient['Runtime'],
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

