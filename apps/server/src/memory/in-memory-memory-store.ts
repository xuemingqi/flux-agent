import type { MemoryEntry } from '@flux-agent/contracts';
import { memoryTerms, type MemoryStore } from './memory-store.js';

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  list(workspaceId: string, query: string, activeOnly: boolean, now: string): MemoryEntry[] {
    const terms = memoryTerms(query);
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.workspaceId === workspaceId &&
          (!activeOnly || (entry.state === 'active' && (!entry.expiresAt || entry.expiresAt > now))) &&
          (!query ||
            (terms.length ? terms : [query.toLowerCase()]).some((term) => entry.content.toLowerCase().includes(term))),
      )
      .map((entry) => structuredClone(entry));
  }

  get(workspaceId: string, id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    return entry?.workspaceId === workspaceId ? structuredClone(entry) : undefined;
  }

  insert(memory: MemoryEntry): void {
    this.entries.set(memory.id, structuredClone(memory));
  }

  update(memory: MemoryEntry, previousVersion: number): boolean {
    if (this.get(memory.workspaceId, memory.id)?.version !== previousVersion) return false;
    this.insert(memory);
    return true;
  }

  delete(workspaceId: string, id: string, version: number): boolean {
    if (this.get(workspaceId, id)?.version !== version) return false;
    return this.entries.delete(id);
  }
}
