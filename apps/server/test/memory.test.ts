import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { pino } from 'pino';
import { isRunActive, type ModelMessage } from '@flux-agent/contracts';
import { MemoryService } from '../src/memory/memory-service.js';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';
import { RunManager } from '../src/runs/run-manager.js';

const directories: string[] = [];
const stores: SqliteRunStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flux-memory-'));
  directories.push(directory);
  const path = join(directory, 'app.db');
  const store = new SqliteRunStore(path);
  stores.push(store);
  const manager = new RunManager(
    store,
    () => ({
      async *stream() {
        yield { type: 'text.delta', text: 'done' };
      },
    }),
    pino({ enabled: false }),
  );
  const first = manager.workspaces.create(directory);
  await mkdir(join(directory, 'second'));
  const second = manager.workspaces.create(join(directory, 'second'));
  return { path, store, manager, first, second, memory: manager.memory };
}

describe('SQLite long-term memory', () => {
  it('brings confirmed identity into a question with no matching keywords and offers scoped paged search', async () => {
    const { first, second, memory } = await fixture();
    const profile = memory.create(first.id, {
      content: '用户姓名：林舟，称呼：小林。',
      pinned: false,
      expiresAt: null,
    });
    expect(memory.retrieve(first.id, '你记得我是谁吗')).toContainEqual(profile);
    memory.create(second.id, { content: '用户姓名：其他人', pinned: true, expiresAt: null });
    const disabled = memory.create(first.id, { content: '用户姓名：已禁用', pinned: true, expiresAt: null });
    memory.update(first.id, disabled.id, { ...disabled, state: 'disabled' });
    for (let index = 0; index < 8; index++)
      memory.create(first.id, { content: `项目约定 ${index}`, pinned: false, expiresAt: null });
    expect(memory.search(first.id, '姓名', 0)).toMatchObject({
      memories: [{ id: profile.id, content: profile.content }],
      total: 1,
      nextOffset: null,
    });
    const seen = new Set<string>();
    let offset: number | null = 0;
    do {
      const result = memory.search(first.id, '', offset);
      result.memories.forEach((entry) => seen.add(entry.id));
      offset = result.nextOffset;
    } while (offset !== null);
    expect(seen.size).toBe(9);
    expect(seen.has(disabled.id)).toBe(false);
  });

  it('upgrades an existing database without losing its saved model or workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flux-memory-upgrade-'));
    directories.push(directory);
    const legacyFolder = join(directory, 'old-migrations');
    await mkdir(join(legacyFolder, 'meta'), { recursive: true });
    const sourceFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
    const journal = JSON.parse(await readFile(join(sourceFolder, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 2);
    await writeFile(join(legacyFolder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(join(sourceFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    const path = join(directory, 'app.db');
    const connection = new Database(path);
    try {
      migrate(drizzle(connection), { migrationsFolder: legacyFolder });
      connection
        .prepare('INSERT INTO model_settings VALUES (?, ?, ?, ?, ?)')
        .run('default', 'https://example.com/v1', 'old-model', 'test-key', new Date().toISOString());
      connection
        .prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)')
        .run('old-workspace', 'Existing', directory, new Date().toISOString());
    } finally {
      connection.close();
    }
    const upgraded = new SqliteRunStore(path);
    stores.push(upgraded);
    expect(upgraded.modelSettings.load()).toMatchObject({
      model: 'old-model',
      apiKey: 'test-key',
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
    });
    expect(upgraded.workspaces.get('old-workspace')?.name).toBe('Existing');
    const memory = new MemoryService(upgraded.memory);
    const entry = memory.create('old-workspace', { content: 'SQLite migration', pinned: false, expiresAt: null });
    expect(memory.retrieve('old-workspace', 'migration')).toEqual([entry]);
  });

  it('requires candidate confirmation and restores source, version, and native model history after restart', async () => {
    const { path, store, manager, first, memory } = await fixture();
    const thread = manager.createThread(first.id);
    const run = manager.startRun(thread.id, '记住约定');
    await vi.waitFor(() => expect(isRunActive(manager.getRun(run.id).status)).toBe(false));
    const candidate = memory.propose(run, '项目采用 TypeScript 和 SQLite');
    expect(memory.propose(run, candidate.content).id).toBe(candidate.id);
    expect(memory.retrieve(first.id, 'TypeScript')).toEqual([]);
    const confirmed = memory.update(first.id, candidate.id, { ...candidate, state: 'active' });
    expect(confirmed).toMatchObject({ version: 2, sourceRunId: run.id, sourceThreadId: thread.id, source: 'agent' });
    const history: ModelMessage[] = [
      { role: 'user', content: 'read' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', args: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'c', content: 'file content' },
      { role: 'assistant', content: 'done' },
    ];
    store.saveModelHistory(run.id, history);
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    const restored = new MemoryService(reopened.memory);
    expect(restored.retrieve(first.id, 'TypeScript')).toEqual([confirmed]);
    expect(reopened.getModelHistory(run.id)).toEqual(history);
  });

  it('isolates workspaces, detects stale updates, and keeps FTS consistent after edit and deletion', async () => {
    const { first, second, memory } = await fixture();
    const entry = memory.create(first.id, { content: '部署环境使用 SQLite，模型约定', pinned: false, expiresAt: null });
    expect(memory.list(first.id, 'sqlite')).toHaveLength(1);
    expect(memory.list(first.id, '部署')).toHaveLength(1);
    expect(memory.list(first.id, '约')).toHaveLength(1);
    expect(memory.list(first.id, '" OR *')).toEqual([]);
    expect(memory.retrieve(second.id, 'sqlite')).toEqual([]);
    expect(() => memory.update(second.id, entry.id, { ...entry, content: 'wrong' })).toThrow('没有这条');
    const updated = memory.update(first.id, entry.id, { ...entry, content: '改为 PostgreSQL' });
    expect(() => memory.update(first.id, entry.id, { ...entry, content: 'stale' })).toThrow('已被修改');
    expect(() => memory.delete(first.id, entry.id, entry.version)).toThrow('已被修改');
    expect(memory.list(first.id, 'sqlite')).toEqual([]);
    expect(memory.list(first.id, 'postgresql')).toEqual([updated]);
    memory.delete(first.id, entry.id, updated.version);
    expect(memory.list(first.id, 'postgresql')).toEqual([]);
  });

  it('excludes disabled and expired entries, prioritizes pinned entries, and bounds retrieval', async () => {
    const { first, memory } = await fixture();
    const disabled = memory.create(first.id, { content: 'TypeScript disabled', pinned: true, expiresAt: null });
    memory.update(first.id, disabled.id, { ...disabled, state: 'disabled' });
    const expires = memory.create(first.id, {
      content: 'TypeScript expired',
      pinned: true,
      expiresAt: new Date(Date.now() + 10000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(expires.expiresAt!) + 100);
    expect(memory.retrieve(first.id, 'TypeScript')).toEqual([]);
    expect(memory.list(first.id)).toHaveLength(2);
    expect(() => memory.create(first.id, { ...expires, content: 'too late' })).toThrow('过期时间');
    const pinned = memory.create(first.id, { content: '无关但置顶', pinned: true, expiresAt: null });
    for (let index = 0; index < 10; index++)
      memory.create(first.id, { content: `TypeScript ${index}`, pinned: false, expiresAt: null });
    const selected = memory.retrieve(first.id, 'TypeScript');
    expect(selected).toHaveLength(6);
    expect(selected[0]!.id).toBe(pinned.id);
    expect(selected.some((entry) => [disabled.id, expires.id].includes(entry.id))).toBe(false);
  });
});
