import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog, utilityProcess, type UtilityProcess } from 'electron';
import { BackendClient } from '../src/backend-client.js';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

describe('Desktop backend lifecycle', () => {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });

  beforeEach(() => {
    vi.useFakeTimers();
    child.removeAllListeners();
    vi.clearAllMocks();
    vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
  });
  afterEach(() => vi.useRealTimers());

  it('waits for readiness, forwards the native selection and shuts down through a message', async () => {
    const failure = vi.fn();
    const client = new BackendClient(() => undefined, failure);
    const starting = client.start('/app/backend.js', {});
    child.emit('message', { type: 'ready', url: 'http://127.0.0.1:41001' });
    expect(await starting).toBe('http://127.0.0.1:41001');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/工作区 空格'] });
    child.emit('message', { type: 'choose-directory', id: 'request' });
    await vi.waitFor(() =>
      expect(child.postMessage).toHaveBeenCalledWith({
        type: 'directory-chosen',
        id: 'request',
        path: '/工作区 空格',
      }),
    );
    const stopping = client.stop();
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' });
    child.emit('exit', 0);
    await stopping;
    expect(failure).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports startup exits and unexpected exits after readiness', async () => {
    const failure = vi.fn();
    const client = new BackendClient(() => undefined, failure);
    const starting = client.start('/app/backend.js', {});
    const rejected = expect(starting).rejects.toThrow('退出码 1');
    child.emit('exit', 1);
    await rejected;
    expect(failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const running = new BackendClient(() => undefined, failure);
    const ready = running.start('/app/backend.js', {});
    child.emit('message', { type: 'ready', url: 'http://127.0.0.1:41001' });
    await ready;
    child.emit('exit', 1);
    expect(failure).toHaveBeenCalledOnce();
  });

  it('rejects remote URLs and bounds startup and shutdown waits', async () => {
    const invalid = new BackendClient(() => undefined, vi.fn());
    const starting = invalid.start('/app/backend.js', {});
    const rejected = expect(starting).rejects.toThrow('无效的本地地址');
    child.emit('message', { type: 'ready', url: 'https://example.com' });
    await rejected;
    expect(vi.getTimerCount()).toBe(0);

    const client = new BackendClient(() => undefined, vi.fn());
    const timeout = client.start('/app/backend.js', {});
    const timedOut = expect(timeout).rejects.toThrow('启动超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    expect(child.kill).toHaveBeenCalledOnce();
    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(7_000);
    await stopping;
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});
