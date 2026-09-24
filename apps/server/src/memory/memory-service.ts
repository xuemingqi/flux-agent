import type { MemoryEntry, MemoryInput, MemoryUpdate, Run } from '@flux-agent/contracts';
import { ApplicationError } from '../api/application-error.js';
import { memoryTerms, type MemoryStore } from './memory-store.js';

const MAX_MEMORIES = 200;
const MAX_CONTEXT_MEMORIES = 6;
const MAX_MEMORY_CONTEXT_CHARACTERS = 6000;
const MEMORY_SEARCH_PAGE_SIZE = 3;

export class MemoryService {
  constructor(private readonly store: MemoryStore) {}

  list(workspaceId: string, query = ''): MemoryEntry[] {
    return this.store.list(workspaceId, query.trim().slice(0, 500), false, new Date().toISOString());
  }

  create(workspaceId: string, input: MemoryInput): MemoryEntry {
    return this.insert(workspaceId, input, null);
  }

  propose(run: Run, content: string): MemoryEntry {
    const existing = this.list(run.workspaceId).find(
      (entry) => entry.sourceRunId === run.id && entry.content === content,
    );
    return existing ?? this.insert(run.workspaceId, { content, pinned: false, expiresAt: null }, run);
  }

  update(workspaceId: string, id: string, input: MemoryUpdate): MemoryEntry {
    const current = this.require(workspaceId, id);
    if (input.state !== 'disabled') this.checkExpiry(input.expiresAt);
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      ...current,
      ...input,
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      version: input.version + 1,
      updatedAt: now,
      confirmedAt: input.state === 'active' ? now : current.confirmedAt,
    };
    if (!this.store.update(entry, input.version))
      throw new ApplicationError('MEMORY_CONFLICT', '记忆已被修改，请刷新后重试。', 409);
    return entry;
  }

  delete(workspaceId: string, id: string, version: number): void {
    this.require(workspaceId, id);
    if (!this.store.delete(workspaceId, id, version))
      throw new ApplicationError('MEMORY_CONFLICT', '记忆已被修改，请刷新后重试。', 409);
  }

  /**
   * 在预算内优先注入置顶和匹配记忆，再补充其他已确认条目；不会跨工作区或使用失效记忆。
   */
  retrieve(workspaceId: string, query: string): MemoryEntry[] {
    const terms = memoryTerms(query);
    const now = new Date().toISOString();
    const matched = this.store.list(workspaceId, query, true, now);
    // 口语问题可能没有词面交集；在预算内补充已确认记忆，少量记忆可直接完整带入。
    const candidates = [
      ...new Map(
        [...matched, ...this.store.list(workspaceId, '', true, now)].map((entry) => [entry.id, entry]),
      ).values(),
    ];
    const score = (entry: MemoryEntry) =>
      (entry.pinned ? 100 : 0) + terms.filter((term) => entry.content.toLowerCase().includes(term)).length;
    candidates.sort((left, right) => score(right) - score(left) || right.updatedAt.localeCompare(left.updatedAt));
    const selected: MemoryEntry[] = [];
    let characters = 0;
    for (const memory of candidates) {
      if (characters + memory.content.length > MAX_MEMORY_CONTEXT_CHARACTERS) continue;
      selected.push(memory);
      characters += memory.content.length;
      if (selected.length === MAX_CONTEXT_MEMORIES) break;
    }
    return selected;
  }

  /**
   * 模型可主动查询已确认记忆，空查询按页浏览；作用域仍由宿主固定，候选和失效条目不返回。
   */
  search(workspaceId: string, query: string, offset: number) {
    const matches = this.store.list(workspaceId, query, true, new Date().toISOString());
    const page = matches.slice(offset, offset + MEMORY_SEARCH_PAGE_SIZE);
    const nextOffset = offset + page.length;
    return {
      memories: page.map(({ id, content, version }) => ({ id, content, version })),
      total: matches.length,
      nextOffset: nextOffset < matches.length ? nextOffset : null,
    };
  }

  /**
   * 用户手工录入立即生效，模型工具提议必须经过页面确认。
   */
  private insert(workspaceId: string, input: MemoryInput, run: Run | null): MemoryEntry {
    this.checkExpiry(input.expiresAt);
    if (this.list(workspaceId).length >= MAX_MEMORIES)
      throw new ApplicationError('MEMORY_LIMIT', '每个工作区最多保存 200 条记忆，请先整理。', 429);
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      ...input,
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      id: crypto.randomUUID(),
      workspaceId,
      version: 1,
      source: run ? 'agent' : 'user',
      sourceRunId: run?.id ?? null,
      sourceThreadId: run?.threadId ?? null,
      state: run ? 'candidate' : 'active',
      createdAt: now,
      updatedAt: now,
      confirmedAt: run ? null : now,
    };
    this.store.insert(entry);
    return entry;
  }

  /**
   * 所有操作使用相同作用域校验，不允许通过另一个工作区访问条目。
   */
  private require(workspaceId: string, id: string): MemoryEntry {
    const entry = this.store.get(workspaceId, id);
    if (!entry) throw new ApplicationError('MEMORY_NOT_FOUND', '该工作区中没有这条记忆。', 404);
    return entry;
  }

  /**
   * 防止新保存的条目立即失效，过期历史仍可在管理页查看。
   */
  private checkExpiry(expiresAt: string | null): void {
    if (expiresAt && Date.parse(expiresAt) <= Date.now())
      throw new ApplicationError('MEMORY_EXPIRED', '过期时间应晚于当前时间，或留空表示不过期。');
  }
}
