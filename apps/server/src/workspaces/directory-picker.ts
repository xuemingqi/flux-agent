import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplicationError } from '../api/application-error.js';

const executeFile = promisify(execFile);
const DIRECTORY_DIALOG_SCRIPT = `try
  return POSIX path of (choose folder with prompt "为 Flux Agent 选择工作区")
on error number -128
  return ""
end try`;

/**
 * 原生选择器只由已认证的用户接口打开，不接受模型提供的脚本或目录参数。
 */
export class DirectoryPicker {
  private active?: AbortController;

  constructor(
    private readonly platform = process.platform,
    private readonly execute = executeFile,
  ) {}

  async choose(signal: AbortSignal): Promise<string | null> {
    if (this.active)
      throw new ApplicationError('DIRECTORY_PICKER_BUSY', '目录选择窗口已打开，请先完成或取消选择。', 409);
    if (this.platform !== 'darwin')
      throw new ApplicationError('DIRECTORY_PICKER_UNAVAILABLE', '当前版本的系统目录选择器支持 macOS。', 503);
    const controller = new AbortController();
    this.active = controller;
    try {
      const { stdout } = await this.execute('/usr/bin/osascript', ['-e', DIRECTORY_DIALOG_SCRIPT], {
        encoding: 'utf8',
        maxBuffer: 8192,
        timeout: 120000,
        signal: AbortSignal.any([signal, controller.signal]),
      });
      // 不使用 trim，保留合法目录名称两侧的空格。
      return stdout.replace(/\r?\n$/, '') || null;
    } catch {
      throw new ApplicationError(
        'DIRECTORY_PICKER_FAILED',
        '目录选择未完成，请点击加号重试，并在系统窗口中选择目录。',
        503,
      );
    } finally {
      this.active = undefined;
    }
  }

  cancel(): void {
    this.active?.abort();
  }
}
