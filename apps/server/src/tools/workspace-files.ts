import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PermissionMode } from '@flux-agent/contracts';
import { ApplicationError } from '../api/application-error.js';

const MAX_FILE_BYTES = 64_000;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_RESULTS = 50;

export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

export class WorkspaceFiles {
  constructor(
    private readonly root: string,
    private readonly mode: PermissionMode,
    private readonly protectedDirectory?: string,
  ) {
    this.root = realpathSync(root);
    this.protectedDirectory = protectedDirectory ? realpathSync(protectedDirectory) : undefined;
  }

  /**
   * 校验真实路径，限制模式拒绝符号链接逃逸；禁止工具直接读取应用密钥与数据库。
   */
  path(input: string, creating = false): string {
    const candidate = resolve(this.root, input);
    let actual: string;
    try {
      actual =
        creating && !this.exists(candidate)
          ? join(realpathSync(dirname(candidate)), basename(candidate))
          : realpathSync(candidate);
    } catch {
      throw new ApplicationError('PATH_NOT_FOUND', '路径不存在或无法访问。');
    }
    if (this.mode !== 'full-access' && !isWithin(this.root, actual)) {
      throw new ApplicationError('PATH_DENIED', '当前权限仅允许访问工作区内的文件。', 403);
    }
    if (this.protectedDirectory && isWithin(this.protectedDirectory, actual)) {
      throw new ApplicationError('PROTECTED_PATH', '文件工具不允许访问 Flux 的密钥和运行数据库。', 403);
    }
    // 写入采用原子替换，不通过符号链接或硬链接改变其他路径的内容。
    if (creating && this.exists(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new ApplicationError('SYMLINK_WRITE', '请直接使用目标文件路径，不允许通过符号链接写入。');
    }
    return actual;
  }

  read(path: string): string {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new ApplicationError('FILE_LIMIT', '只支持读取 64 KB 以内的普通文本文件。');
      const bytes = readFileSync(descriptor);
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0))
        throw new ApplicationError('FILE_LIMIT', '文件过大或不是文本文件。');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      closeSync(descriptor);
    }
  }

  snapshot(path: string): string | null {
    return this.exists(path) ? this.read(path) : null;
  }

  list(path: string): string {
    const entries = readdirSync(path, { withFileTypes: true });
    return JSON.stringify({
      entries: entries.slice(0, 200).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
      })),
      truncated: entries.length > 200,
    });
  }

  search(path: string, query: string): string {
    const matches: { path: string; line: number; text: string }[] = [];
    let visited = 0;
    let truncated = false;
    const pending = [path];
    while (pending.length && !truncated) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue;
        const file = join(directory, entry.name);
        if (this.protectedDirectory && isWithin(this.protectedDirectory, file)) continue;
        if (++visited > MAX_SEARCH_FILES) {
          truncated = true;
          break;
        }
        if (entry.isDirectory()) {
          pending.push(file);
          continue;
        }
        if (!entry.isFile()) continue;
        let content: string;
        try {
          content = this.read(this.path(file));
        } catch {
          continue;
        }
        for (const [index, line] of content.split('\n').entries()) {
          if (!line.includes(query)) continue;
          matches.push({ path: relative(this.root, file), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
    return JSON.stringify({ matches, truncated });
  }

  /**
   * 审批后重新校验路径和原文，避免覆盖等待期间用户修改的文件。
   */
  write(input: string, expectedPath: string, before: string | null, content: string): void {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw new ApplicationError('FILE_LIMIT', '单次写入不能超过 64 KB。');
    const path = this.path(input, true);
    if (path !== expectedPath || this.snapshot(path) !== before)
      throw new ApplicationError('FILE_CHANGED', '文件在审批期间发生变化，本次修改未执行。请重新读取后再申请。', 409);
    const temporary = join(dirname(path), `.flux-${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: before === null ? 0o644 : statSync(path).mode & 0o777 });
      renameSync(temporary, path);
    } finally {
      if (this.exists(temporary)) unlinkSync(temporary);
    }
  }

  /**
   * 使用 lstat 区分不存在与不可读，不能把读取失败误当作新文件。
   */
  private exists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
