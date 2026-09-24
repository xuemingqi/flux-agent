import { describe, expect, it, vi } from 'vitest';
import { DirectoryPicker } from '../src/workspaces/directory-picker.js';

describe('Native workspace picker', () => {
  it('runs a fixed folder dialog script without a shell and treats cancellation as an empty result', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '/tmp/项目 空格/\n' })
      .mockResolvedValueOnce({ stdout: '\n' });
    const picker = new DirectoryPicker('darwin', execute);
    expect(await picker.choose(new AbortController().signal)).toBe('/tmp/项目 空格/');
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', expect.stringContaining('choose folder')],
      expect.objectContaining({ encoding: 'utf8', timeout: 120000, signal: expect.any(AbortSignal) }),
    );
    expect(await picker.choose(new AbortController().signal)).toBeNull();
  });

  it('prevents duplicate dialogs and aborts the process on shutdown without leaking process errors', async () => {
    const execute = vi.fn(
      (_file, _args, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('private process details')), { once: true }),
        ),
    );
    const picker = new DirectoryPicker('darwin', execute);
    const choosing = picker.choose(new AbortController().signal);
    await expect(picker.choose(new AbortController().signal)).rejects.toMatchObject({ code: 'DIRECTORY_PICKER_BUSY' });
    picker.cancel();
    await expect(choosing).rejects.toMatchObject({ code: 'DIRECTORY_PICKER_FAILED' });
    execute.mockResolvedValueOnce({ stdout: '\n' });
    expect(await picker.choose(new AbortController().signal)).toBeNull();
  });
});
