import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { MemoryEntry } from '@flux-agent/contracts';
import { memoryTerms, type MemoryStore } from '../memory/memory-store.js';
import { memories } from './schema.js';

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly database: BetterSQLite3Database) {}

  list(workspaceId: string, query: string, activeOnly: boolean, now: string): MemoryEntry[] {
    const terms = memoryTerms(query);
    const long = terms.filter((term) => [...term].length >= 3);
    const short = terms.filter((term) => [...term].length < 3);
    const clauses = [];
    if (long.length) {
      // 对用户输入逐词引用，FTS 操作符不能变成任意查询表达式。
      const match = long.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      clauses.push(sql`${memories.id} IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ${match})`);
    }
    for (const term of short) clauses.push(sql`instr(lower(${memories.content}), ${term}) > 0`);
    if (query && !terms.length) clauses.push(sql`instr(lower(${memories.content}), ${query.toLowerCase()}) > 0`);
    return this.database
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          activeOnly
            ? and(eq(memories.state, 'active'), or(isNull(memories.expiresAt), gt(memories.expiresAt, now)))
            : undefined,
          query ? or(...clauses) : undefined,
        ),
      )
      .orderBy(desc(memories.pinned), desc(memories.updatedAt))
      .limit(200)
      .all();
  }

  get(workspaceId: string, id: string): MemoryEntry | undefined {
    return this.database
      .select()
      .from(memories)
      .where(and(eq(memories.workspaceId, workspaceId), eq(memories.id, id)))
      .get();
  }

  insert(memory: MemoryEntry): void {
    this.database.insert(memories).values(memory).run();
  }

  update(memory: MemoryEntry, previousVersion: number): boolean {
    return (
      this.database
        .update(memories)
        .set(memory)
        .where(
          and(
            eq(memories.workspaceId, memory.workspaceId),
            eq(memories.id, memory.id),
            eq(memories.version, previousVersion),
          ),
        )
        .run().changes === 1
    );
  }

  delete(workspaceId: string, id: string, version: number): boolean {
    return (
      this.database
        .delete(memories)
        .where(and(eq(memories.workspaceId, workspaceId), eq(memories.id, id), eq(memories.version, version)))
        .run().changes === 1
    );
  }
}
