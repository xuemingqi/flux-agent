import { unzipSync, zipSync } from 'fflate';
import { ApplicationError } from '../api/application-error.js';

export const MAX_SKILL_BYTES = 20_000_000;
const MAX_ARCHIVE_BYTES = 21_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function skillPath(path: string): string {
  if (
    !path ||
    path.length > 500 ||
    /[\\:\0]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ApplicationError('INVALID_SKILL_PATH', 'Skill 文件路径必须是安全的相对路径。');
  return path;
}

export function decodeBase64(content: string): Buffer {
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) throw new ApplicationError('INVALID_BASE64', '文件内容不是有效的 Base64。');
  return bytes;
}

export function skillText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ApplicationError('INVALID_SKILL_TEXT', '此文件不是有效的 UTF-8 文本。');
  }
}

/** ZIP 在解压前检查中央目录，限制展开体积，拒绝链接、重名和越界路径。 */
export function readSkillArchive(bytes: Buffer): Record<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ApplicationError('SKILL_LIMIT', 'ZIP 文件不能超过 21 MB。');
  try {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
      throw new Error('Missing ZIP directory');
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Split ZIP');
    const count = bytes.readUInt16LE(end + 10);
    if (!count || count > 500) throw new Error('Too many entries');
    let offset = bytes.readUInt32LE(end + 16);
    let total = 0;
    const names = new Set<string>();
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
      const length = bytes.readUInt16LE(offset + 28);
      const raw = skillText(bytes.subarray(offset + 46, offset + 46 + length));
      const path = skillPath(raw.endsWith('/') ? raw.slice(0, -1) : raw);
      const key = path.normalize('NFC').toLowerCase();
      if (names.has(key)) throw new Error('Duplicate ZIP path');
      names.add(key);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      if ((mode & 0xf000) === 0xa000 || bytes.readUInt16LE(offset + 8) & 1) throw new Error('Link or encrypted ZIP');
      total += bytes.readUInt32LE(offset + 24);
      if (total > MAX_SKILL_BYTES) throw new Error('ZIP size limit');
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    if (offset !== end) throw new Error('Unsupported ZIP directory');
    const files = unzipSync(bytes, {
      filter: (file) => !file.name.endsWith('/') && file.originalSize <= MAX_SKILL_BYTES,
    });
    const manifests = Object.keys(files).filter((path) => path.split('/').at(-1) === 'SKILL.md');
    if (manifests.length !== 1) throw new Error('Expected one SKILL.md');
    const prefix = manifests[0]!.slice(0, -'SKILL.md'.length);
    if (Object.keys(files).some((path) => !path.startsWith(prefix))) throw new Error('Files outside Skill');
    return Object.fromEntries(
      Object.entries(files).map(([path, content]) => [skillPath(path.slice(prefix.length)), content]),
    );
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      'INVALID_SKILL_ARCHIVE',
      'ZIP 包无效：需包含一个 SKILL.md，且不能包含链接、重复路径或越界文件。',
    );
  }
}

export function writeSkillArchive(name: string, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`${name}/${path}`, bytes])), { level: 6 }),
  );
}
