import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChromeClient, BrowserLogger } from './types.js';

export interface BrowserSession {
  url: string;
  timestamp: number;
  promptText: string;
  attachmentPaths?: string[];
  conversationId?: string;
  sessionDir: string;
}

const SESSION_FILE = 'browser_session.json';

export async function saveSessionState(
  sessionDir: string,
  url: string,
  promptText: string,
  attachmentPaths?: string[],
): Promise<void> {
  const session: BrowserSession = {
    url,
    timestamp: Date.now(),
    promptText: promptText.slice(0, 200), // Store first 200 chars as preview
    attachmentPaths,
    conversationId: extractConversationId(url),
    sessionDir,
  };

  const sessionFile = path.join(sessionDir, SESSION_FILE);
  await fs.writeFile(sessionFile, JSON.stringify(session, null, 2));
}

export async function loadSessionState(sessionDir: string): Promise<BrowserSession | null> {
  try {
    const sessionFile = path.join(sessionDir, SESSION_FILE);
    const content = await fs.readFile(sessionFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function getCurrentConversationUrl(Runtime: ChromeClient['Runtime']): Promise<string> {
  const { result } = await Runtime.evaluate({
    expression: 'window.location.href',
    returnByValue: true,
  });
  return result?.value as string;
}

export async function waitForConversationUrl(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';

  while (Date.now() < deadline) {
    const url = await getCurrentConversationUrl(Runtime);

    // Check if we have a conversation ID in the URL (ChatGPT pattern)
    if (url.includes('/c/') || url.includes('/g/')) {
      if (url !== lastUrl) {
        logger(`Conversation URL established: ${url}`);
        lastUrl = url;
        // Wait a bit to ensure URL is stable
        await new Promise((resolve) => setTimeout(resolve, 500));
        const verifyUrl = await getCurrentConversationUrl(Runtime);
        if (verifyUrl === url) {
          return url;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // If no conversation URL found, return current URL
  const finalUrl = await getCurrentConversationUrl(Runtime);
  logger(`Using current URL (no conversation ID detected): ${finalUrl}`);
  return finalUrl;
}

function extractConversationId(url: string): string | undefined {
  // Extract conversation ID from ChatGPT URLs
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)|\/g\/([a-zA-Z0-9-]+)/);
  return match?.[1] || match?.[2];
}

export async function navigateToSavedSession(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  session: BrowserSession,
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    logger(`Recovering session: navigating to ${session.url}`);
    await Page.navigate({ url: session.url });

    // Wait for page to load
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const { result } = await Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (result?.value === 'complete' || result?.value === 'interactive') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Verify we're on the right conversation
    const currentUrl = await getCurrentConversationUrl(Runtime);
    const currentConvId = extractConversationId(currentUrl);

    if (session.conversationId && currentConvId === session.conversationId) {
      logger(`Successfully recovered session (conversation ${session.conversationId})`);
      return true;
    } else if (currentUrl === session.url) {
      logger('Successfully navigated to saved URL');
      return true;
    } else {
      logger(`Warning: Navigated to ${currentUrl}, expected ${session.url}`);
      return false;
    }
  } catch (error) {
    logger(`Failed to recover session: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function detectPageRefresh(
  Runtime: ChromeClient['Runtime'],
  lastKnownUrl: string,
): Promise<boolean> {
  try {
    const currentUrl = await getCurrentConversationUrl(Runtime);
    return currentUrl !== lastKnownUrl;
  } catch {
    // If we can't get the URL, assume a refresh/disconnect happened
    return true;
  }
}