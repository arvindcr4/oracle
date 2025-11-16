import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserLock } from '../../src/browser/lock.js';

describe('acquireBrowserLock', () => {
  test('acquires and releases a lock file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-lock-test-'));
    const lockPath = path.join(tmpDir, 'browser.lock');
    const logger = vi.fn();

    const release = await acquireBrowserLock({ lockPath, logger });
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    await release();
    await expect(fs.access(lockPath)).rejects.toBeDefined();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Acquired global Oracle browser lock'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Released global Oracle browser lock'));
  });

  test('second waiter acquires lock after first is released', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-lock-test-'));
    const lockPath = path.join(tmpDir, 'browser.lock');
    const logger = vi.fn();

    const releaseFirst = await acquireBrowserLock({ lockPath, logger });

    let secondAcquired = false;
    const secondPromise = acquireBrowserLock({ lockPath, logger }).then(async (releaseSecond) => {
      secondAcquired = true;
      await releaseSecond();
    });

    // Give the second waiter a chance to attempt acquisition and start waiting
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondAcquired).toBe(false);

    // Releasing the first lock should allow the second to proceed
    await releaseFirst();
    await secondPromise;
    expect(secondAcquired).toBe(true);
  });
});

