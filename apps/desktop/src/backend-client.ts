import { dialog, utilityProcess, type BrowserWindow, type OpenDialogOptions, type UtilityProcess } from 'electron';
import type { BackendMessage } from './messages.js';

const STARTUP_TIMEOUT = 30_000;
const SHUTDOWN_TIMEOUT = 7_000;

export class BackendClient {
  private child?: UtilityProcess;

  private exited = false;

  private stopping = false;

  private stopPromise?: Promise<void>;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly onFailure: () => void,
  ) {}

  start(entry: string, environment: NodeJS.ProcessEnv): Promise<string> {
    const child = utilityProcess.fork(entry, [], { env: environment, serviceName: 'Flux Agent Backend' });
    this.child = child;
    let ready = false;
    child.on('message', (message: BackendMessage) => {
      if (message.type === 'choose-directory' && !this.stopping) void this.chooseDirectory(child, message.id);
    });
    child.once('exit', () => {
      this.exited = true;
      if (ready && !this.stopping) this.onFailure();
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        this.stopping = true;
        child.kill();
        reject(new Error('后台启动超时。'));
      }, STARTUP_TIMEOUT);
      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('exit', exit);
        child.removeListener('message', receive);
      };
      const exit = (code: number) => {
        cleanup();
        reject(new Error(`后台未能启动（退出码 ${code}）。`));
      };
      const receive = (message: BackendMessage) => {
        if (message.type !== 'ready') return;
        cleanup();
        if (!URL.canParse(message.url)) {
          reject(new Error('后台返回了无效的本地地址。'));
          return;
        }
        const url = new URL(message.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
          reject(new Error('后台返回了无效的本地地址。'));
          return;
        }
        ready = true;
        resolve(url.origin);
      };
      child.once('exit', exit);
      child.on('message', receive);
    });
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    this.stopping = true;
    this.stopPromise ??= new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, SHUTDOWN_TIMEOUT);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      // Windows 上也先通过消息取消运行、关闭 SQLite，再结束后台进程。
      child.postMessage({ type: 'shutdown' });
    });
    return this.stopPromise;
  }

  // 原生窗口绑定工作台，所选目录只返回给发起请求的后台。
  private async chooseDirectory(child: UtilityProcess, id: string): Promise<void> {
    try {
      const options: OpenDialogOptions = { title: '为 Flux Agent 选择工作区', properties: ['openDirectory'] };
      const window = this.getWindow();
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (!this.stopping && !this.exited)
        child.postMessage({
          type: 'directory-chosen',
          id,
          path: result.canceled ? null : (result.filePaths[0] ?? null),
        });
    } catch {
      if (!this.stopping && !this.exited) child.postMessage({ type: 'directory-chosen', id, path: null, failed: true });
    }
  }
}
