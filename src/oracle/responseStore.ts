import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface StoredResponse {
  id: string;
  model: string;
  prompt: string;
  timestamp: number;
  status?: string;
}

const RESPONSE_STORE_DIR = path.join(os.homedir(), '.oracle', 'responses');
const RESPONSE_INDEX_FILE = path.join(RESPONSE_STORE_DIR, 'index.json');

async function ensureStoreDir(): Promise<void> {
  try {
    await fs.mkdir(RESPONSE_STORE_DIR, { recursive: true });
  } catch {
    // Directory already exists or cannot be created
  }
}

export async function storeResponseId(
  responseId: string,
  model: string,
  prompt: string,
  status?: string,
): Promise<void> {
  await ensureStoreDir();

  const storedResponse: StoredResponse = {
    id: responseId,
    model,
    prompt: prompt.slice(0, 100), // Store first 100 chars as preview
    timestamp: Date.now(),
    status,
  };

  let index: StoredResponse[] = [];
  try {
    const existing = await fs.readFile(RESPONSE_INDEX_FILE, 'utf-8');
    index = JSON.parse(existing);
  } catch {
    // File doesn't exist or is invalid, start fresh
  }

  // Add new response, keep only last 100 responses
  index.unshift(storedResponse);
  if (index.length > 100) {
    index = index.slice(0, 100);
  }

  await fs.writeFile(RESPONSE_INDEX_FILE, JSON.stringify(index, null, 2));
}

export async function getStoredResponses(): Promise<StoredResponse[]> {
  try {
    const content = await fs.readFile(RESPONSE_INDEX_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export async function getResponseById(responseId: string): Promise<StoredResponse | null> {
  const responses = await getStoredResponses();
  return responses.find((r) => r.id === responseId) || null;
}

export async function updateResponseStatus(responseId: string, status: string): Promise<void> {
  const responses = await getStoredResponses();
  const index = responses.findIndex((r) => r.id === responseId);
  if (index !== -1) {
    responses[index].status = status;
    await fs.writeFile(RESPONSE_INDEX_FILE, JSON.stringify(responses, null, 2));
  }
}