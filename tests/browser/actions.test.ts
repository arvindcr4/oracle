import { describe, it, expect, vi } from 'vitest';
import { verifyAttachmentsVisible } from '../../src/browser/actions/attachments';
import { ChromeClient } from '../../src/browser/types';

describe('verifyAttachmentsVisible', () => {
  it('should correctly identify visible attachments', async () => {
    const mockRuntime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              filename: 'test.txt',
              selector: '[data-testid*="attachment-pill"]',
              outerHTML: '<div data-testid="attachment-pill">test.txt</div>',
            },
          ],
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const attachments = await verifyAttachmentsVisible(mockRuntime);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('test.txt');
  });
});
