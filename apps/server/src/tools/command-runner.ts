import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ToolResult } from '@flux-agent/agent-runtime';

const MAX_CAPTURE_CHARACTERS = 64_000;

/**
 * 仅完全权限调用的本机 Shell，不宣称具有容器隔离能力。
 * 命令等待完成或用户停止；只限制返回的日志体积，不因时长或输出量杀死进程。
 */
export async function* runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): AsyncGenerator<string, ToolResult> {
  if (process.platform === 'win32') return { content: '当前命令工具仅支持 macOS 和 Linux。', failed: true };
  signal.throwIfAborted();
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    },
  });
  let pendingOutput = '';
  let output = '';
  let truncated = false;
  let finished = false;
  let exitCode: number | null = null;
  let failure = '';
  let wake: (() => void) | undefined;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = '无法结束命令进程组。';
      }
    }
    wake?.();
  };
  const aborted = () => {
    failure = '命令已取消。';
    stop();
  };
  signal.addEventListener('abort', aborted, { once: true });
  const capture = (text: string) => {
    if (!text) return;
    truncated ||= output.length + text.length > MAX_CAPTURE_CHARACTERS;
    output = (output + text).slice(-MAX_CAPTURE_CHARACTERS);
    pendingOutput = (pendingOutput + text).slice(-MAX_CAPTURE_CHARACTERS);
    wake?.();
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer) => {
      if (failure) return;
      capture(decoder.write(chunk));
    });
    stream.on('end', () => {
      capture(decoder.end());
    });
  }
  child.once('error', () => {
    failure = '命令无法启动，请检查工作目录。';
  });
  child.once('close', (code) => {
    exitCode = code;
    finished = true;
    wake?.();
  });
  try {
    while (!finished || pendingOutput) {
      if (pendingOutput) {
        const text = pendingOutput;
        pendingOutput = '';
        yield text;
        continue;
      }
      if (!finished)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
    }
    signal.throwIfAborted();
    return {
      content: JSON.stringify({
        output,
        exitCode,
        truncated,
        ...(truncated ? { note: '仅返回末尾日志；命令未因输出量被停止。需要完整日志时请将输出重定向到文件。' } : {}),
        ...(failure ? { error: failure } : {}),
      }),
      failed: !!failure || exitCode !== 0,
    };
  } finally {
    signal.removeEventListener('abort', aborted);
    stop();
  }
}
