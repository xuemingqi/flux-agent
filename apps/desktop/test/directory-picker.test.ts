import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DesktopDirectoryPicker } from '../src/directory-picker.js';

describe('Desktop directory picker', () => {
  it('matches replies to the active request and preserves directory names', async () => {
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    const picker = new DesktopDirectoryPicker(port);
    const selection = picker.choose(new AbortController().signal);
    const { id } = port.postMessage.mock.calls[0]![0];
    expect(() => picker.choose(new AbortController().signal)).toThrow('目录选择窗口已打开');
    port.emit('message', { data: { type: 'directory-chosen', id: 'another-request', path: '/wrong' } });
    port.emit('message', { data: { type: 'directory-chosen', id, path: '/项目 空格 /' } });
    expect(await selection).toBe('/项目 空格 /');

    const cancelled = picker.choose(new AbortController().signal);
    const nextId = port.postMessage.mock.calls[1]![0].id;
    port.emit('message', { data: { type: 'directory-chosen', id: nextId, path: null } });
    expect(await cancelled).toBeNull();
  });

  it('clears cancelled requests and reports native dialog failures without process details', async () => {
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    const picker = new DesktopDirectoryPicker(port);
    const controller = new AbortController();
    const selection = picker.choose(controller.signal);
    const rejected = expect(selection).rejects.toMatchObject({ code: 'DIRECTORY_PICKER_CANCELLED' });
    controller.abort();
    await rejected;
    port.emit('message', {
      data: { type: 'directory-chosen', id: port.postMessage.mock.calls[0]![0].id, path: '/late' },
    });
    const failed = picker.choose(new AbortController().signal);
    port.emit('message', {
      data: { type: 'directory-chosen', id: port.postMessage.mock.calls[1]![0].id, path: null, failed: true },
    });
    await expect(failed).rejects.toMatchObject({ code: 'DIRECTORY_PICKER_FAILED' });
    const stopping = picker.choose(new AbortController().signal);
    const stopped = expect(stopping).rejects.toMatchObject({ code: 'DIRECTORY_PICKER_CANCELLED' });
    picker.cancel();
    await stopped;
  });
});
