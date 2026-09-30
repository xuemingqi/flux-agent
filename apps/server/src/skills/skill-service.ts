import { parseDocument } from 'yaml';
import {
  capabilityNameSchema,
  skillInputSchema,
  type Skill,
  type SkillInput,
  type SkillUpdate,
} from '@flux-agent/contracts';
import type { CapabilityStore } from '../storage/capability-store.js';
import { ApplicationError } from '../api/application-error.js';
import {
  decodeBase64,
  MAX_SKILL_BYTES,
  readSkillArchive,
  skillPath,
  skillText,
  writeSkillArchive,
} from './skill-archive.js';

/** Skill 基础能力；页面和 Tool 的编排层都通过这里维护同一份资源。 */
export class SkillService {
  constructor(private readonly store: CapabilityStore) {}

  list() {
    return this.store
      .skills()
      .map(({ markdown: _markdown, files, ...entry }) => ({ ...entry, fileCount: files.length + 1 }));
  }

  get(name: string): Skill {
    const entry = this.store.skills().find((skill) => skill.name === name);
    if (!entry) throw new ApplicationError('SKILL_NOT_FOUND', 'Skill 不存在。', 404);
    return entry;
  }

  create(input: SkillInput): Skill {
    const prepared = this.validate(input);
    if (this.list().some((entry) => entry.name === input.name))
      throw new ApplicationError('SKILL_EXISTS', '同名 Skill 已存在，请编辑现有 Skill。', 409);
    const now = new Date().toISOString();
    const entry = { ...prepared, version: 1, createdAt: now, updatedAt: now };
    this.store.saveSkill(entry);
    return entry;
  }

  update(name: string, input: SkillUpdate): Skill {
    const previous = this.get(name);
    this.checkVersion(previous, input.version);
    if (input.name !== name) throw new ApplicationError('SKILL_NAME_CHANGED', '修改内容时请保留 Skill 名称。');
    const { version: _version, ...data } = input;
    const entry = {
      ...previous,
      ...this.validate({ ...data, files: data.files ?? previous.files }),
      version: previous.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveSkill(entry);
    return entry;
  }

  delete(name: string, version: number): void {
    this.checkVersion(this.get(name), version);
    this.store.deleteSkill(name);
  }

  prepareImport(filename: string, content: string): SkillInput {
    const bytes = decodeBase64(content);
    const files = filename.toLowerCase().endsWith('.zip')
      ? readSkillArchive(bytes)
      : filename.toLowerCase() === 'skill.md'
        ? { 'SKILL.md': bytes }
        : null;
    if (!files) throw new ApplicationError('INVALID_SKILL_FORMAT', '请选择 ZIP 包或 SKILL.md 文件。');
    const markdown = skillText(files['SKILL.md']!);
    const metadata = this.metadata(markdown);
    const prepared = this.validate({
      name: metadata.name,
      markdown,
      enabled: true,
      files: Object.entries(files)
        .filter(([path]) => path !== 'SKILL.md')
        .map(([path, bytes]) => ({ path, content: Buffer.from(bytes).toString('base64') })),
    });
    const { description: _description, ...input } = prepared;
    return input;
  }

  import(filename: string, content: string): Skill {
    return this.create(this.prepareImport(filename, content));
  }

  export(name: string) {
    const entry = this.get(name);
    const files = Object.fromEntries(entry.files.map((file) => [file.path, decodeBase64(file.content)]));
    files['SKILL.md'] = Buffer.from(entry.markdown);
    return { filename: `${name}.zip`, content: writeSkillArchive(name, files).toString('base64') };
  }

  read(name: string, path = 'SKILL.md') {
    const entry = this.get(name);
    if (!entry.enabled) throw new ApplicationError('SKILL_DISABLED', '此 Skill 已禁用。', 403);
    skillPath(path);
    const file = entry.files.find((file) => file.path === path);
    if (path !== 'SKILL.md' && !file) throw new ApplicationError('SKILL_FILE_NOT_FOUND', 'Skill 资源文件不存在。', 404);
    return {
      name,
      path,
      content: path === 'SKILL.md' ? entry.markdown : skillText(decodeBase64(file!.content)),
      files: entry.files.map((file) => file.path),
    };
  }

  /** 原文保留供编辑和导出，元数据只解析一次用于校验和运行时发现。 */
  private metadata(markdown: string): { name: string; description: string } {
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(markdown);
    if (!match || !match[2]!.trim())
      throw new ApplicationError('INVALID_SKILL', 'SKILL.md 需含 YAML name、description 和非空正文。');
    try {
      const document = parseDocument(match[1]!);
      if (document.errors.length) throw new Error('Invalid YAML');
      const data = document.toJS({ maxAliasCount: 0 });
      const name = capabilityNameSchema.parse(data?.name);
      if (typeof data?.description !== 'string' || !data.description.trim() || data.description.length > 2000)
        throw new Error('Invalid description');
      return { name, description: data.description.trim() };
    } catch {
      throw new ApplicationError('INVALID_SKILL', 'Skill 名称需为小写字母、数字或连字符，并填写 description。');
    }
  }

  /** 每个写入入口共享路径、元数据与总大小检查，避免绕过 ZIP 检查直接写资源。 */
  private validate(input: SkillInput): SkillInput & { description: string } {
    const result = skillInputSchema.safeParse(input);
    if (!result.success) throw new ApplicationError('INVALID_SKILL', 'Skill 参数格式不正确。');
    const data = result.data;
    const metadata = this.metadata(data.markdown);
    if (metadata.name !== data.name)
      throw new ApplicationError('INVALID_SKILL', '名称必须与 SKILL.md 中的 name 一致。');
    const paths = new Set(['skill.md']);
    let bytes = Buffer.byteLength(data.markdown);
    for (const file of data.files) {
      const path = skillPath(file.path).normalize('NFC').toLowerCase();
      if (paths.has(path) || path.split('/').at(-1) === 'skill.md')
        throw new ApplicationError('INVALID_SKILL_PATH', '资源文件不能重复或包含另一个 SKILL.md。');
      paths.add(path);
      bytes += decodeBase64(file.content).length;
    }
    if (bytes > MAX_SKILL_BYTES) throw new ApplicationError('SKILL_LIMIT', 'Skill 展开后不能超过 20 MB。');
    return { ...data, description: metadata.description };
  }

  /** 版本绑定审批和写入，用户或并发任务更新后旧请求不能覆盖新内容。 */
  private checkVersion(entry: Skill, version: number): void {
    if (entry.version !== version)
      throw new ApplicationError('CAPABILITY_CONFLICT', 'Skill 已变化，请刷新后重试。', 409);
  }
}
