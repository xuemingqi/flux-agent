import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pino } from 'pino';
import type { AgentExecutionContext, AgentRuntime, ToolRequest } from '@flux-agent/agent-runtime';
import { runSchema, type Run, type UpdatePlan } from '@flux-agent/contracts';
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
  const directory = await mkdtemp(join(tmpdir(), 'flux-plan-'));
  directories.push(directory);
  const path = join(directory, 'app.db');
  const store = new SqliteRunStore(path);
  stores.push(store);
  const manager = new RunManager(store, () => runtime, pino({ enabled: false }));
  managers.push(manager);
  const workspace = manager.workspaces.create(directory);
  return { manager, store, path, thread: manager.createThread(workspace.id) };
}

async function execute(context: AgentExecutionContext, signal: AbortSignal, request: ToolRequest) {
  const iterator = context.execute(request, signal);
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  return next.value;
}

const plan: UpdatePlan = {
  version: 0,
  explanation: '先检查，再整理结果。',
  steps: [
    { id: 'read', title: '检查项目内容', status: 'in_progress' },
    { id: 'report', title: '整理结果', status: 'pending' },
  ],
};

async function finished(manager: RunManager, id: string): Promise<Run> {
  await vi.waitFor(() => expect(manager.getRun(id).finishedAt).not.toBeNull());
  return manager.getRun(id);
}

describe('Run plans and feedback', () => {
  it('persists plans, execution receipts, feedback and agent identity across restart without leaking to another run', async () => {
    const contexts: string[] = [];
    const { manager, store, path, thread } = await setup({
      identity: { name: 'test-agent', version: '7' },
      async *stream(messages, signal, context) {
        contexts.push(JSON.stringify(messages));
        expect(context!.getPlan!()).toBeNull();
        if (messages.at(-1)!.content === 'plan') {
          const first = await execute(context!, signal, { id: 'plan-1', name: 'update_plan', input: plan });
          expect(first.failed).toBe(false);
          expect(context!.getPlan!()).toMatchObject({ version: 1, steps: plan.steps });
          const updated = { ...plan, version: 1, steps: plan.steps.map((step) => ({ ...step, status: 'completed' })) };
          expect((await execute(context!, signal, { id: 'plan-2', name: 'update_plan', input: updated })).failed).toBe(
            false,
          );
        }
        yield { type: 'text.delta', text: '结果' };
      },
    });
    const run = manager.startRun(thread.id, 'plan');
    expect((await finished(manager, run.id)).plan).toMatchObject({ version: 2 });
    const feedback = { rating: 'unhelpful' as const, comment: '请补充来源，这是私有反馈', version: 0 };
    manager.saveFeedback(run.id, feedback);
    expect(() => manager.saveFeedback(run.id, feedback)).toThrow('其他页面');
    const another = manager.startRun(manager.createThread(thread.workspaceId).id, 'separate');
    expect((await finished(manager, another.id)).plan).toBeNull();
    const followup = manager.startRun(thread.id, 'followup');
    await finished(manager, followup.id);
    expect(contexts.join('\n')).not.toContain('私有反馈');
    const snapshot = manager.getThread(thread.id);
    await manager.shutdown();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.threads.get(thread.id)).toEqual(snapshot);
    expect(reopened.runs.get(run.id)).toMatchObject({
      agent: { name: 'test-agent', version: '7' },
      feedback: { ...feedback, version: 1 },
    });
    expect(reopened.getExecution(run.id, 'plan-2')?.status).toBe('succeeded');
  });

  it('rejects conflicting, invalid and duplicate updates without changing plan or file permissions', async () => {
    const { manager, thread } = await setup({
      async *stream(_messages, signal, context) {
        const call = (id: string, input: unknown) => execute(context!, signal, { id, name: 'update_plan', input });
        expect((await call('first', plan)).failed).toBe(false);
        expect((await call('stale', plan)).content).toContain('PLAN_CONFLICT');
        expect((await call('first', { ...plan, version: 1 })).content).toContain('DUPLICATE_TOOL_CALL');
        expect(
          (await call('duplicate-step', { ...plan, version: 1, steps: [plan.steps[0], plan.steps[0]] })).content,
        ).toContain('INVALID_PLAN');
        expect(
          (
            await call('parallel', {
              ...plan,
              version: 1,
              steps: plan.steps.map((step) => ({ ...step, status: 'in_progress' })),
            })
          ).content,
        ).toContain('INVALID_PLAN');
        expect((await call('empty', { ...plan, version: 1, steps: [] })).content).toContain('INVALID_TOOL_INPUT');
        expect(
          (await call('over-limit', { ...plan, version: 1, steps: Array(13).fill(plan.steps[0]) })).content,
        ).toContain('INVALID_TOOL_INPUT');
        expect((await call('elevate', { ...plan, version: 1, permissionMode: 'full-access' })).content).toContain(
          'INVALID_TOOL_INPUT',
        );
        expect(context!.getPlan!()?.version).toBe(1);
        expect(context!.permissionMode).toBe('read-only');
        expect(
          (
            await execute(context!, signal, {
              id: 'write',
              name: 'write_file',
              input: { path: 'denied.txt', content: 'no' },
            })
          ).content,
        ).toContain('WRITE_DENIED');
        yield { type: 'text.delta', text: '完成检查，保留尚未完成计划' };
      },
    });
    manager.setPermission(thread.id, 'read-only', false);
    const run = manager.startRun(thread.id, 'validate');
    const completed = await finished(manager, run.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.plan).toMatchObject({ version: 1, steps: plan.steps });
  });

  it('keeps incomplete progress on cancellation and interrupted recovery and blocks feedback on active runs', async () => {
    const ready = Promise.withResolvers<void>();
    const { manager, store, path, thread } = await setup({
      async *stream(_messages, signal, context) {
        await execute(context!, signal, { id: 'plan', name: 'update_plan', input: plan });
        ready.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    const run = manager.startRun(thread.id, 'slow');
    await ready.promise;
    expect(() => manager.saveFeedback(run.id, { rating: 'helpful', comment: '', version: 0 })).toThrow('结束后');
    manager.cancelRun(run.id);
    const cancelled = await finished(manager, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.plan?.steps).toEqual(plan.steps);
    const saved = store.runs.get(run.id)!;
    saved.status = 'running';
    saved.finishedAt = null;
    store.saveRun(store.threads.get(thread.id)!, saved);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    expect(reopened.runs.get(run.id)).toMatchObject({ status: 'interrupted', plan: { version: 1, steps: plan.steps } });
  });

  it('versions edits and withdrawal and restores older run snapshots without inventing metadata', async () => {
    const { manager, thread } = await setup({
      async *stream() {
        yield { type: 'text.delta', text: 'reply' };
      },
    });
    const run = manager.startRun(thread.id, 'hello');
    const completed = await finished(manager, run.id);
    manager.saveFeedback(run.id, { rating: 'helpful', comment: '', version: 0 });
    const edited = manager.saveFeedback(run.id, { rating: 'unhelpful', comment: '修正意见', version: 1 });
    expect(edited.feedback).toMatchObject({ version: 2, rating: 'unhelpful', comment: '修正意见' });
    expect(manager.saveFeedback(run.id, { rating: null, comment: '', version: 2 }).feedback).toMatchObject({
      version: 3,
      rating: null,
      comment: '',
    });
    expect(() => manager.saveFeedback(run.id, { rating: 'helpful', comment: '', version: 0 })).toThrow('其他页面');
    const { plan: _plan, feedback: _feedback, agent: _agent, ...legacy } = completed;
    expect(runSchema.parse(legacy)).toMatchObject({ plan: null, feedback: null, agent: null });
  });
});
