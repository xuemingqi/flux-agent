import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pino } from 'pino';
import type { AgentRuntime, SteeringInbox } from '@flux-agent/agent-runtime';
import { RunManager } from '../src/runs/run-manager.js';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';

const directories: string[] = [];
const stores: SqliteRunStore[] = [];
const managers: RunManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(runtime: AgentRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'flux-steering-'));
  directories.push(directory);
  const path = join(directory, 'app.db');
  const store = new SqliteRunStore(path);
  stores.push(store);
  const manager = new RunManager(store, () => runtime, pino({ enabled: false }));
  managers.push(manager);
  const workspace = manager.workspaces.create(directory);
  return { manager, store, path, directory, workspace, thread: manager.createThread(workspace.id) };
}

function reopen(store: SqliteRunStore, path: string) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new SqliteRunStore(path);
  stores.push(reopened);
  return reopened;
}

describe('Durable steering and workspace actions', () => {
  it('deduplicates retries, closes admission atomically, and persists applied messages and model history', async () => {
    const ready = Promise.withResolvers<SteeringInbox>();
    const release = Promise.withResolvers<void>();
    const { manager, store, path, thread } = await setup({
      supportsSteering: true,
      async *stream(messages, _signal, context) {
        const inbox = context!.steering!;
        ready.resolve(inbox);
        await release.promise;
        context!.saveMessages!([
          ...messages,
          ...inbox.pending().map((entry) => ({ role: 'user' as const, content: entry.content, steeringId: entry.id })),
          { role: 'assistant', content: '调整完成' },
        ]);
        inbox.apply(inbox.pending().map((entry) => entry.id));
        expect(inbox.finish()).toBe(true);
        yield { type: 'text.delta', text: '调整完成' };
      },
    });
    const run = manager.startRun(thread.id, '原任务');
    const inbox = await ready.promise;
    const input = { id: crypto.randomUUID(), content: '只给结论' };
    manager.steerRun(run.id, input);
    expect(manager.steerRun(run.id, input).steering).toHaveLength(1);
    expect(() => manager.steerRun(run.id, { ...input, content: '不同内容' })).toThrow('标识已被使用');
    expect(inbox.finish()).toBe(false);
    const save = vi.spyOn(store, 'saveRun').mockImplementationOnce(() => {
      throw new Error('disk');
    });
    expect(() => manager.steerRun(run.id, { id: crypto.randomUUID(), content: '未接收' })).toThrow('disk');
    save.mockRestore();
    expect(inbox.pending()).toHaveLength(1);
    release.resolve();
    await vi.waitFor(() => expect(store.getModelHistory(run.id)).toBeDefined());
    await vi.waitFor(() => expect(manager.getRun(run.id).finishedAt).not.toBeNull());
    expect(manager.getRun(run.id).steering[0]!.status).toBe('applied');
    expect(manager.steerRun(run.id, input).steering).toHaveLength(1);
    expect(() => manager.steerRun(run.id, { id: crypto.randomUUID(), content: '迟到' })).toThrow('结束');
    await manager.shutdown();
    const restored = reopen(store, path);
    expect(restored.getModelHistory(run.id)?.[1]).toMatchObject({ steeringId: input.id, content: input.content });
    expect(restored.runs.get(run.id)?.steering).toEqual(manager.getRun(run.id).steering);
  });

  it('records applied inputs once and refuses late input before a final response is committed', async () => {
    const ready = Promise.withResolvers<SteeringInbox>();
    const { manager, store, path, thread } = await setup({
      supportsSteering: true,
      async *stream(_messages, signal, context) {
        ready.resolve(context!.steering!);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    const run = manager.startRun(thread.id, '原任务');
    const inbox = await ready.promise;
    const input = { id: crypto.randomUUID(), content: '调整方向' };
    manager.steerRun(run.id, input);
    inbox.apply([input.id]);
    inbox.apply([input.id]);
    expect(manager.getRun(run.id).steps.filter((step) => step.kind === 'steering')).toHaveLength(1);
    expect(inbox.finish()).toBe(true);
    expect(() => manager.steerRun(run.id, { id: crypto.randomUUID(), content: '迟到' })).toThrow('结束');
    expect(manager.getRun(run.id).status).toBe('running');
    await manager.shutdown();
    expect(reopen(store, path).runs.get(run.id)?.steering[0]).toMatchObject({
      status: 'applied',
      content: input.content,
    });
  });

  it('marks pending input unprocessed on cancel and process recovery without replay', async () => {
    const ready = Promise.withResolvers<void>();
    const { manager, store, path, thread } = await setup({
      supportsSteering: true,
      async *stream(_messages, signal) {
        ready.resolve();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    const run = manager.startRun(thread.id, '原任务');
    await ready.promise;
    manager.steerRun(run.id, { id: crypto.randomUUID(), content: '尚未处理' });
    const interruptedSnapshot = manager.getRun(run.id);
    manager.cancelRun(run.id);
    expect(() => manager.steerRun(run.id, { id: crypto.randomUUID(), content: '太晚' })).toThrow('结束');
    await manager.shutdown();
    expect(manager.getRun(run.id).steering[0]!.status).toBe('not_applied');
    store.saveRun(store.threads.get(thread.id)!, interruptedSnapshot);
    expect(reopen(store, path).runs.get(run.id)).toMatchObject({
      status: 'interrupted',
      steering: [{ status: 'not_applied' }],
    });
  });

  it('keeps files and memories but does not restore deleted conversations when re-adding a workspace', async () => {
    const { manager, store, path, directory, workspace, thread } = await setup({
      async *stream() {
        yield { type: 'text.delta', text: '完成' };
      },
    });
    await writeFile(join(directory, 'keep.txt'), '保留文件');
    manager.memory.create(workspace.id, { content: '项目约定', pinned: true, expiresAt: null });
    const run = manager.startRun(thread.id, '保留会话');
    expect(() => manager.workspaces.archive(workspace.id)).toThrow('正在运行');
    await vi.waitFor(() => expect(manager.getRun(run.id).finishedAt).not.toBeNull());
    manager.workspaces.rename(workspace.id, '显示名称');
    const archived = manager.workspaces.archive(workspace.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(manager.listThreads()).toEqual([]);
    expect(() => manager.getThread(thread.id)).toThrow('会话不存在');
    expect(() => manager.getRun(run.id)).toThrow('运行不存在');
    expect(() => manager.createThread(workspace.id)).toThrow('重新添加');
    await manager.shutdown();
    const restored = reopen(store, path);
    const restarted = new RunManager(restored, () => undefined, pino({ enabled: false }));
    managers.push(restarted);
    expect(restarted.workspaces.require(workspace.id)).toMatchObject({
      name: '显示名称',
      archivedAt: archived.archivedAt,
    });
    expect(restarted.workspaces.create(directory)).toMatchObject({
      id: workspace.id,
      name: '显示名称',
      archivedAt: null,
    });
    expect(restarted.listThreads()).toEqual([]);
    expect(() => restarted.getThread(thread.id)).toThrow('会话不存在');
    expect(restarted.memory.retrieve(workspace.id, '项目约定')).toHaveLength(1);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('保留文件');
  });
});
