import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pino } from 'pino';
import Database from 'better-sqlite3';
import { isRunActive, type Run } from '@flux-agent/contracts';
import type { AgentRuntime } from '@flux-agent/agent-runtime';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';
import { RunManager } from '../src/runs/run-manager.js';

const directories: string[] = [];
const stores: SqliteRunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function waitFor(manager: RunManager, id: string, predicate: (run: Run) => boolean): Promise<Run> {
  if (predicate(manager.getRun(id))) return Promise.resolve(manager.getRun(id));
  return new Promise((resolve) => {
    const stop = manager.subscribe(id, () => {
      const run = manager.getRun(id);
      if (predicate(run)) {
        stop();
        resolve(run);
      }
    });
  });
}

const runtime: AgentRuntime = {
  async *stream(messages, signal, context) {
    const write = messages.at(-1)?.content === 'write';
    const name = write ? 'write_file' : 'read_file';
    const input = write ? { path: 'hello.txt', content: 'saved change' } : { path: 'hello.txt' };
    yield { type: 'tool.start', id: 'call', name, input: JSON.stringify(input) };
    const tool = context!.execute({ id: 'call', name, input }, signal);
    let next = await tool.next();
    while (!next.done) {
      yield { type: 'tool.progress', id: 'call', text: next.value };
      next = await tool.next();
    }
    yield { type: 'tool.end', id: 'call', output: next.value.content, failed: next.value.failed };
    yield { type: 'text.delta', text: next.value.content };
  },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flux-sqlite-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  await mkdir(root);
  await writeFile(join(root, 'hello.txt'), 'persisted text');
  const path = join(directory, 'data', 'app.db');
  const store = new SqliteRunStore(path);
  stores.push(store);
  const manager = new RunManager(store, () => runtime, pino({ enabled: false }));
  const workspace = manager.workspaces.create(root);
  const thread = manager.createThread(workspace.id);
  return { path, root, store, manager, workspace, thread };
}

describe('SQLite run storage', () => {
  it('renames a thread durably and deletes only its records and memory provenance', async () => {
    const { store, manager, thread, path, workspace, root } = await fixture();
    manager.renameThread(thread.id, '自定义会话');
    const sibling = manager.createThread(workspace.id);
    const run = manager.startRun(thread.id, 'read');
    expect(() => manager.deleteThread(thread.id)).toThrow('正在运行');
    await waitFor(manager, run.id, (value) => !isRunActive(value.status));
    expect(manager.getThread(thread.id).title).toBe('自定义会话');
    store.saveModelHistory(run.id, [
      { role: 'user', content: 'read' },
      { role: 'assistant', content: 'done' },
    ]);
    const memory = manager.memory.propose(manager.getRun(run.id), '保留记忆');
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.threads.get(thread.id)?.title).toBe('自定义会话');
    const restarted = new RunManager(reopened, () => runtime, pino({ enabled: false }));
    restarted.deleteThread(thread.id);
    expect(restarted.getThread(sibling.id).title).toBe('新对话');
    expect(reopened.getModelHistory(run.id)).toBeUndefined();
    expect(reopened.getExecution(run.id, 'call')).toBeUndefined();
    expect(reopened.memory.get(workspace.id, memory.id)).toMatchObject({
      content: memory.content,
      sourceThreadId: null,
      sourceRunId: null,
    });
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('persisted text');
    expect(() => restarted.getThread(thread.id)).toThrow('会话不存在');
  });

  it('restores context summaries and independent child histories, and interrupts active children after restart', async () => {
    const { store, path, workspace } = await fixture();
    const summary = {
      coveredMessages: 1,
      summary: '用户任务代号 orchid',
      beforeTokens: 10000,
      afterTokens: 1000,
      createdAt: new Date().toISOString(),
    };
    const runner = new RunManager(
      store,
      () => ({
        async *stream(messages, _signal, execution) {
          execution!.recordCompaction!(summary);
          execution!.recordSubagent!({
            id: 'child',
            name: '分析',
            task: '读取',
            status: 'succeeded',
            output: '子任务结果',
            steps: [],
            messages: [
              { role: 'user', content: '读取' },
              { role: 'assistant', content: '子任务结果' },
            ],
            context: [],
            compaction: null,
            usage: null,
            error: null,
            createdAt: summary.createdAt,
            finishedAt: summary.createdAt,
          });
          execution!.saveMessages!([...messages, { role: 'assistant', content: '完成' }]);
          yield { type: 'text.delta', text: '完成' };
        },
      }),
      pino({ enabled: false }),
    );
    const run = runner.startRun(runner.createThread(workspace.id).id, '任务');
    await waitFor(runner, run.id, (value) => !isRunActive(value.status));
    const snapshot = runner.getRun(run.id);
    await runner.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.runs.get(run.id)).toMatchObject({ compaction: summary, subagents: snapshot.subagents });
    const restored = reopened.runs.get(run.id)!;
    restored.status = 'running';
    restored.subagents[0]!.status = 'running';
    reopened.saveRun(reopened.threads.get(run.threadId)!, restored);
    reopened.close();
    stores.splice(stores.indexOf(reopened), 1);
    const recovered = new SqliteRunStore(path);
    stores.push(recovered);
    expect(recovered.runs.get(run.id)?.subagents[0]).toMatchObject({ status: 'interrupted', output: '子任务结果' });
  });

  it('deletes a workspace conversation and all related records while preserving other workspaces and memory', async () => {
    const { store, manager, thread, path, root, workspace } = await fixture();
    manager.createThread(workspace.id);
    manager.setPermission(thread.id, 'workspace-write', false);
    const run = manager.startRun(thread.id, 'write');
    const pending = await waitFor(manager, run.id, (value) => value.status === 'waiting_approval');
    expect(() => manager.workspaces.archive(workspace.id)).toThrow('正在运行');
    manager.approvals.decide(run.id, pending.approvals[0]!.id, 'approved');
    await waitFor(manager, run.id, (value) => !isRunActive(value.status));
    store.saveModelHistory(run.id, [
      { role: 'user', content: 'write' },
      { role: 'assistant', content: 'written' },
    ]);
    const memory = manager.memory.propose(manager.getRun(run.id), '独立记忆内容');
    const otherRoot = join(root, 'other');
    await mkdir(otherRoot);
    await writeFile(join(otherRoot, 'hello.txt'), 'other file');
    const other = manager.workspaces.create(otherRoot);
    const otherThread = manager.createThread(other.id);
    const otherRun = manager.startRun(otherThread.id, 'read');
    await waitFor(manager, otherRun.id, (value) => !isRunActive(value.status));
    const otherSnapshot = manager.getThread(otherThread.id);
    manager.workspaces.archive(workspace.id);
    expect(manager.listThreads().map((entry) => entry.id)).toEqual([otherThread.id]);
    expect(store.getModelHistory(run.id)).toBeUndefined();
    expect(store.getExecution(run.id, 'call')).toBeUndefined();
    expect(store.memory.get(workspace.id, memory.id)).toMatchObject({
      content: memory.content,
      sourceThreadId: null,
      sourceRunId: null,
    });
    expect(manager.getThread(otherThread.id)).toEqual(otherSnapshot);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('saved change');
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const inspection = new Database(path, { readonly: true });
    try {
      for (const table of ['messages', 'approvals', 'model_histories', 'tool_executions'])
        expect(inspection.prepare(`SELECT count(*) AS count FROM ${table} WHERE run_id = ?`).get(run.id)).toEqual({
          count: 0,
        });
      expect(inspection.pragma('foreign_key_check')).toEqual([]);
    } finally {
      inspection.close();
    }
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.threads.get(otherThread.id)).toEqual(otherSnapshot);
    expect(reopened.threads.has(thread.id)).toBe(false);
    expect(reopened.runs.has(run.id)).toBe(false);
    const restarted = new RunManager(reopened, () => runtime, pino({ enabled: false }));
    expect(restarted.workspaces.create(root).id).toBe(workspace.id);
    expect(restarted.listThreads().filter((entry) => entry.workspaceId === workspace.id)).toEqual([]);
  });

  it('rolls back all conversation deletion and memory changes when SQLite rejects the transaction', async () => {
    const { store, manager, thread, path, workspace } = await fixture();
    const run = manager.startRun(thread.id, 'read');
    await waitFor(manager, run.id, (value) => !isRunActive(value.status));
    store.saveModelHistory(run.id, [
      { role: 'user', content: 'read' },
      { role: 'assistant', content: 'done' },
    ]);
    const memory = manager.memory.propose(manager.getRun(run.id), '保留来源');
    const snapshot = manager.getThread(thread.id);
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const connection = new Database(path);
    try {
      connection.exec(
        "CREATE TRIGGER reject_thread_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'test delete failure'); END",
      );
    } finally {
      connection.close();
    }
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    const restarted = new RunManager(reopened, () => runtime, pino({ enabled: false }));
    expect(() => restarted.workspaces.archive(workspace.id)).toThrow('test delete failure');
    expect(restarted.workspaces.require(workspace.id).archivedAt).toBeNull();
    expect(restarted.getThread(thread.id)).toEqual(snapshot);
    expect(reopened.getModelHistory(run.id)).toHaveLength(2);
    expect(reopened.getExecution(run.id, 'call')?.status).toBe('succeeded');
    expect(reopened.memory.get(workspace.id, memory.id)).toEqual(memory);
  });

  it('restores ordered messages, tool results and fixed run permissions after reopening the database', async () => {
    const { store, manager, thread, path, workspace } = await fixture();
    expect(thread.permissionMode).toBe('workspace-write');
    const run = manager.startRun(thread.id, 'read');
    await waitFor(manager, run.id, (value) => !isRunActive(value.status));
    expect(store.getExecution(run.id, 'call')?.status).toBe('succeeded');
    manager.setPermission(thread.id, 'read-only', false);
    const snapshot = manager.getThread(thread.id);
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.threads.get(thread.id)).toEqual(snapshot);
    expect(reopened.threads.get(thread.id)?.permissionMode).toBe('read-only');
    expect(reopened.runs.get(run.id)?.permissionMode).toBe('workspace-write');
    expect(reopened.workspaces.get(workspace.id)).toEqual(workspace);
    expect(reopened.runs.get(run.id)?.steps.at(-2)).toMatchObject({
      name: 'read_file',
      status: 'succeeded',
      output: 'persisted text',
    });
  });

  it('expires stale approvals and marks unknown side effects interrupted without rerunning them', async () => {
    const { store, manager, thread, path, root } = await fixture();
    const started = manager.startRun(thread.id, 'read');
    await waitFor(manager, started.id, (run) => !isRunActive(run.status));
    const run = store.runs.get(started.id)!;
    run.status = 'waiting_approval';
    run.finishedAt = null;
    run.steps[0] = {
      id: 'unknown-write',
      kind: 'tool',
      name: 'write_file',
      input: '{}',
      output: '',
      progress: [],
      status: 'running',
      createdAt: run.createdAt,
      finishedAt: null,
    };
    run.approvals.push({
      id: 'pending',
      runId: run.id,
      toolCallId: 'pending-write',
      workspaceId: run.workspaceId,
      inputHash: 'hash',
      path: join(root, 'hello.txt'),
      before: 'persisted text',
      after: 'must not write',
      status: 'pending',
      createdAt: run.createdAt,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      decidedAt: null,
    });
    store.saveThread(store.threads.get(thread.id)!);
    store.saveExecution({
      runId: run.id,
      toolCallId: 'unknown-write',
      name: 'write_file',
      inputHash: 'hash',
      status: 'started',
      result: null,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    const restored = reopened.runs.get(run.id)!;
    expect(restored.status).toBe('interrupted');
    expect(restored.approvals[0]!.status).toBe('expired');
    expect(restored.steps[0]).toMatchObject({ status: 'interrupted' });
    expect(reopened.getExecution(run.id, 'unknown-write')?.status).toBe('interrupted');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('persisted text');
    const nextManager = new RunManager(reopened, () => runtime, pino({ enabled: false }));
    expect(() => nextManager.approvals.decide(run.id, 'pending', 'approved')).toThrow();
    const next = nextManager.startRun(thread.id, 'read');
    expect((await waitFor(nextManager, next.id, (value) => !isRunActive(value.status))).status).toBe('succeeded');
  });

  it('persists approval decisions and forbids changing permission while a tool waits', async () => {
    const { store, manager, thread, path, root } = await fixture();
    expect(() => manager.setPermission(thread.id, 'full-access', false)).toThrow('明确确认');
    manager.setPermission(thread.id, 'workspace-write', false);
    const run = manager.startRun(thread.id, 'write');
    const pending = await waitFor(manager, run.id, (value) => value.status === 'waiting_approval');
    expect(() => manager.setPermission(thread.id, 'full-access', true)).toThrow('停止');
    manager.approvals.decide(run.id, pending.approvals[0]!.id, 'approved');
    expect((await waitFor(manager, run.id, (value) => !isRunActive(value.status))).status).toBe('succeeded');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('saved change');
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.runs.get(run.id)!.approvals[0]!.status).toBe('approved');
    expect(reopened.getExecution(run.id, 'call')?.status).toBe('succeeded');
  });
});
