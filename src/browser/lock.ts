import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserLogger } from "./types.js";
import { delay } from "./utils.js";

interface BrowserLockOptions {
	lockPath?: string;
	timeoutMs?: number;
	logger?: BrowserLogger;
}

interface BrowserLockPayload {
	pid: number;
	createdAt: number;
}

const DEFAULT_ORACLE_HOME = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

function resolveLockPath(explicitPath?: string): string {
	if (explicitPath) {
		return explicitPath;
	}
	return path.join(DEFAULT_ORACLE_HOME, "browser.lock");
}

async function readExistingLock(lockPath: string): Promise<BrowserLockPayload | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as BrowserLockPayload;
		if (!parsed || typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire a cross-process lock so that only one Oracle browser automation
 * run launches Chrome at a time. This prevents multiple ChatGPT windows
 * from opening concurrently when callers start several Oracle runs in
 * parallel.
 *
 * The returned function releases the lock and should be called in a `finally`
 * block once the browser run has finished.
 */
export async function acquireBrowserLock(
	options: BrowserLockOptions = {},
): Promise<() => Promise<void>> {
	const lockPath = resolveLockPath(options.lockPath);
	const logger = options.logger;
	const timeoutMs = options.timeoutMs ?? 30 * 60_000; // 30 minutes soft cap
	const start = Date.now();
	const deadline = start + timeoutMs;

	await fs.mkdir(path.dirname(lockPath), { recursive: true });

	const payload: BrowserLockPayload = {
		pid: process.pid,
		createdAt: Date.now(),
	};
	const payloadJson = JSON.stringify(payload);
	const retryDelayMs = 750;
	let hasLoggedWaiting = false;

	// Try to create the lock file atomically. If it already exists, wait for the
	// owning process to finish (or for the lock to become stale) before retrying.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await fs.writeFile(lockPath, payloadJson, { flag: "wx" });
			if (logger) {
				logger("Acquired global Oracle browser lock");
			}
			break;
		} catch (error: unknown) {
			const err = error as { code?: string } | undefined;
			if (!err || (err.code !== "EEXIST" && err.code !== "EACCES" && err.code !== "EPERM")) {
				throw error;
			}

			const existing = await readExistingLock(lockPath);
			if (!existing) {
				// Corrupt or missing payload; try again.
				await delay(retryDelayMs);
				continue;
			}

			// If the recorded owner process is gone, treat the lock as stale.
			if (!isProcessAlive(existing.pid)) {
				try {
					await fs.rm(lockPath, { force: true });
					if (logger) {
						logger(
							`Removed stale Oracle browser lock held by pid ${existing.pid}; ` +
								"resuming browser launch.",
						);
					}
				} catch {
					// If we can't remove it, fall back to waiting and retrying.
				}
				await delay(retryDelayMs);
				continue;
			}

			if (!hasLoggedWaiting && logger) {
				logger(
					`Another Oracle browser run (pid ${existing.pid}) is active; ` +
						"waiting for it to finish before launching a new browser.",
				);
				hasLoggedWaiting = true;
			}

			if (timeoutMs > 0 && Date.now() > deadline) {
				throw new Error(
					"Timed out waiting for another Oracle browser run to finish. " +
						"If this keeps happening, remove the browser.lock file from your ORACLE_HOME directory.",
				);
			}

			await delay(retryDelayMs);
		}
	}

	let released = false;
	return async () => {
		if (released) {
			return;
		}
		released = true;
		try {
			const existing = await readExistingLock(lockPath);
			if (existing && existing.pid === process.pid) {
				await fs.rm(lockPath, { force: true });
				if (logger) {
					logger("Released global Oracle browser lock");
				}
			}
		} catch {
			// Ignore release failures; at worst a stale lock remains and will be
			// cleaned up by a future run via isProcessAlive().
		}
	};
}

