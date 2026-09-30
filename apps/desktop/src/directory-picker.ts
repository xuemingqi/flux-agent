import { randomUUID } from 'node:crypto';
import type { ParentPort } from 'electron';
import { ApplicationError } from '../../server/src/api/application-error.js';
import type { HostMessage } from './messages.js';

interface PendingSelection {
  id: string;
  resolve: (path: string | null) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
}

/**
 * 后台只请求选目录，由 Electron 主进程显示 macOS / Windows 原生窗口。
 */
export class DesktopDirectoryPicker {
  private pending?: PendingSelection;

  constructor(private readonly port: Pick<ParentPort, 'on' | 'postMessage'>) {
    port.on('message', ({ data }: { data: HostMessage }) => {
      const pending = this.pending;
      if (data.type !== 'directory-chosen' || !pending || data.id !== pending.id) return;
      this.clear();
      if (data.failed)
        pending.reject(new ApplicationError('DIRECTORY_PICKER_FAILED', '无法打开目录选择窗口，请重试。', 503));
      else pending.resolve(data.path);
    });
  }

  choose(signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    if (this.pending)
      throw new ApplicationError('DIRECTORY_PICKER_BUSY', '目录选择窗口已打开，请先完成或取消选择。', 409);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.clear();
        reject(new ApplicationError('DIRECTORY_PICKER_CANCELLED', '目录选择已取消。', 503));
      };
      const id = randomUUID();
      this.pending = { id, resolve, reject, signal, abort };
      signal.addEventListener('abort', abort, { once: true });
      this.port.postMessage({ type: 'choose-directory', id });
    });
  }

  cancel(): void {
    this.pending?.abort();
  }

  // 移除请求监听，忽略取消后迟到的原生窗口结果。
  private clear(): void {
    this.pending?.signal.removeEventListener('abort', this.pending.abort);
    this.pending = undefined;
  }
}
