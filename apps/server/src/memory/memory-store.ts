import type { MemoryEntry } from '@flux-agent/contracts';

/**
 * 记忆查询必须带工作区，更新和删除使用版本号防止覆盖并发修改。
 */
export interface MemoryStore {
  list(workspaceId: string, query: string, activeOnly: boolean, now: string): MemoryEntry[];
  get(workspaceId: string, id: string): MemoryEntry | undefined;
  insert(memory: MemoryEntry): void;
  update(memory: MemoryEntry, previousVersion: number): boolean;
  delete(workspaceId: string, id: string, version: number): boolean;
}

/**
 * 中文按词检索；短词由存储层回退为子串匹配，避免 trigram 的三字限制。
 */
export function memoryTerms(query: string): string[] {
  const stopWords = new Set(['什么', '怎么', '如何', '请问', '帮我', '我们', '这个', '那个', '是否', '应该', '使用']);
  return [
    ...new Set(
      [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query)]
        .filter((part) => part.isWordLike && [...part.segment].length >= 2 && !stopWords.has(part.segment))
        .map((part) => part.segment.toLocaleLowerCase()),
    ),
  ].slice(0, 16);
}
