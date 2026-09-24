import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRuntime, ConversationMessage } from '@flux-agent/agent-runtime';
import { pino } from 'pino';
import { InMemoryRunStore } from '../src/runs/in-memory-run-store.js';
import { RunManager } from '../src/runs/run-manager.js';

const logger = pino({ enabled: false });

function managerFor(runtime: AgentRuntime | null) {
  return new RunManager(new InMemoryRunStore(), () => runtime, logger);
}

function finished(manager: RunManager, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = manager.subscribe(runId, () => {
      if (manager.getRun(runId).finishedAt) {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe('RunManager', () => {
  it('keeps reasoning, commentary and parallel tool progress in order without adding reasoning to conversation context', async () => {
    const contexts: ConversationMessage[][] = [];
    const manager = managerFor({
      async *stream(messages) {
        contexts.push(messages);
        yield { type: 'reasoning.delta', text: '分析' };
        yield { type: 'reasoning.delta', text: '问题' };
        yield { type: 'text.delta', text: '开始查询。' };
        yield { type: 'tool.start', id: 'first', name: 'lookup', input: '{"id":1}' };
        yield { type: 'tool.start', id: 'second', name: 'lookup', input: '{"id":2}' };
        yield { type: 'tool.progress', id: 'first', text: '已读取第一页' };
        yield { type: 'tool.end', id: 'second', output: '没有权限', failed: true };
        yield { type: 'tool.end', id: 'first', output: '查询结果', failed: false };
        yield { type: 'text.delta', text: '最终答复。' };
      },
    });
    const thread = manager.createThread();
    const run = manager.startRun(thread.id, '查询');
    await finished(manager, run.id);
    const result = manager.getRun(run.id);
    expect(result.steps.map((step) => step.kind)).toEqual(['reasoning', 'text', 'tool', 'tool', 'text']);
    expect(result.steps[0]).toMatchObject({ content: '分析问题' });
    expect(result.steps[2]).toMatchObject({
      id: 'first',
      status: 'succeeded',
      progress: ['已读取第一页'],
      output: '查询结果',
    });
    expect(result.steps[3]).toMatchObject({ id: 'second', status: 'failed', output: '没有权限' });
    expect(result.output).toBe('开始查询。\n\n最终答复。');
    const next = manager.startRun(thread.id, '继续');
    await finished(manager, next.id);
    expect(contexts[1]?.[1]).toEqual({ role: 'assistant', content: result.output });
    expect(JSON.stringify(contexts[1])).not.toContain('分析问题');
  });

  it('closes running tools after cancellation while preserving their progress', async () => {
    const started = Promise.withResolvers<void>();
    const manager = managerFor({
      async *stream(_messages, signal) {
        yield { type: 'tool.start', id: 'pending', name: 'lookup', input: '{}' };
        yield { type: 'tool.progress', id: 'pending', text: '正在读取' };
        started.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    const run = manager.startRun(manager.createThread().id, '慢速工具');
    await started.promise;
    const completed = finished(manager, run.id);
    manager.cancelRun(run.id);
    await completed;
    const result = manager.getRun(run.id);
    expect(result.steps[0]).toMatchObject({
      status: 'cancelled',
      finishedAt: result.finishedAt,
      progress: ['正在读取'],
    });
  });

  it('keeps running when verbose tools exceed the previous process output limit', async () => {
    const manager = managerFor({
      async *stream() {
        yield { type: 'tool.start', id: 'large', name: 'lookup', input: '{}' };
        yield { type: 'tool.progress', id: 'large', text: 'a'.repeat(256001) };
        yield { type: 'tool.end', id: 'large', output: 'done', failed: false };
        yield { type: 'text.delta', text: '完成' };
      },
    });
    const run = manager.startRun(manager.createThread().id, '过长过程');
    await finished(manager, run.id);
    const result = manager.getRun(run.id);
    expect(result).toMatchObject({ status: 'succeeded', error: null });
    expect(result.steps[0]).toMatchObject({ status: 'succeeded' });
    expect(result.steps[0]?.kind === 'tool' && result.steps[0].progress.join('')).toContain('早期进度已省略');
  });

  it('preserves answers beyond the previous output limit and completes normally', async () => {
    const manager = managerFor({
      async *stream() {
        yield { type: 'text.delta', text: 'a'.repeat(128001) };
      },
    });
    const run = manager.startRun(manager.createThread().id, '过长回复');
    await finished(manager, run.id);
    expect(manager.getRun(run.id)).toMatchObject({ status: 'succeeded', output: 'a'.repeat(128001), error: null });
  });

  it('streams text, records usage and passes only the selected conversation to the next turn', async () => {
    const contexts: ConversationMessage[][] = [];
    const manager = managerFor({
      async *stream(messages) {
        contexts.push(messages);
        yield { type: 'text.delta', text: '你好' };
        yield { type: 'text.delta', text: '，世界' };
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
      },
    });
    const first = manager.createThread();
    const run = manager.startRun(first.id, '你好');
    await finished(manager, run.id);
    expect(manager.getRun(run.id)).toMatchObject({
      status: 'succeeded',
      output: '你好，世界',
      usage: { totalTokens: 7 },
    });
    const followup = manager.startRun(first.id, '继续');
    await finished(manager, followup.id);
    expect(contexts[1]).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，世界' },
      { role: 'user', content: '继续' },
    ]);
    const separate = manager.startRun(manager.createThread().id, '独立问题');
    await finished(manager, separate.id);
    expect(contexts[2]).toEqual([{ role: 'user', content: '独立问题' }]);
  });

  it('rejects overlapping turns and publishes cancelled only after cleanup completes', async () => {
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const manager = managerFor({
      async *stream(_messages, signal): AsyncIterable<AgentEvent> {
        yield { type: 'text.delta', text: '部分回复' };
        started.resolve();
        try {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          signal.throwIfAborted();
        } finally {
          await cleanup.promise;
        }
      },
    });
    const thread = manager.createThread();
    const run = manager.startRun(thread.id, '你好');
    await started.promise;
    expect(() => manager.startRun(thread.id, '重叠')).toThrow('正在生成');
    const completed = finished(manager, run.id);
    expect(manager.cancelRun(run.id).status).toBe('cancelling');
    expect(manager.getRun(run.id).finishedAt).toBeNull();
    cleanup.resolve();
    await completed;
    expect(manager.getRun(run.id)).toMatchObject({ status: 'cancelled', output: '部分回复' });
    expect(manager.cancelRun(run.id).status).toBe('cancelled');
  });

  it('keeps a run alive after its subscriber disconnects', async () => {
    const release = Promise.withResolvers<void>();
    const manager = managerFor({
      async *stream() {
        await release.promise;
        yield { type: 'text.delta', text: '完成' };
      },
    });
    const run = manager.startRun(manager.createThread().id, '你好');
    const listener = vi.fn();
    manager.subscribe(run.id, listener)();
    const completed = finished(manager, run.id);
    release.resolve();
    await completed;
    expect(manager.getRun(run.id).status).toBe('succeeded');
    expect(listener).not.toHaveBeenCalled();
  });

  it('sanitizes provider failures, releases the thread and excludes incomplete turns from context', async () => {
    let attempt = 0;
    const contexts: ConversationMessage[][] = [];
    const manager = managerFor({
      async *stream(messages) {
        contexts.push(messages);
        if (attempt++ === 0) {
          yield { type: 'text.delta', text: '不完整' };
          throw new Error('private-key-do-not-leak');
        }
        yield { type: 'text.delta', text: '重试成功' };
      },
    });
    const thread = manager.createThread();
    const failed = manager.startRun(thread.id, '失败的问题');
    await finished(manager, failed.id);
    expect(manager.getRun(failed.id).status).toBe('failed');
    expect(JSON.stringify(manager.getThread(thread.id))).not.toContain('private-key');
    const retry = manager.startRun(thread.id, '重新提问');
    await finished(manager, retry.id);
    expect(contexts[1]).toEqual([{ role: 'user', content: '重新提问' }]);
  });

  it('fails empty responses and rejects missing configuration without appending a message', async () => {
    const manager = managerFor({ async *stream() {} });
    const run = manager.startRun(manager.createThread().id, '你好');
    await finished(manager, run.id);
    expect(manager.getRun(run.id).error?.code).toBe('EMPTY_RESPONSE');
    const unconfigured = managerFor(null);
    const thread = unconfigured.createThread();
    expect(() => unconfigured.startRun(thread.id, '你好')).toThrow('配置');
    expect(unconfigured.getThread(thread.id).messages).toHaveLength(0);
  });

  it('cancels all active model requests on shutdown', async () => {
    const manager = managerFor({
      async *stream(_messages, signal) {
        yield { type: 'text.delta', text: '开始' };
        if (!signal.aborted)
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    const run = manager.startRun(manager.createThread().id, '你好');
    await manager.shutdown();
    expect(manager.getRun(run.id).status).toBe('cancelled');
  });

  it('waits beyond the old task deadline and stops only when the user cancels', async () => {
    vi.useFakeTimers();
    const ready = Promise.withResolvers<void>();
    const manager = managerFor({
      async *stream(_messages, signal) {
        yield { type: 'text.delta', text: '等待任务完成' };
        ready.resolve();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    });
    try {
      const run = manager.startRun(manager.createThread().id, '长任务');
      await ready.promise;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(manager.getRun(run.id)).toMatchObject({ status: 'running', finishedAt: null });
      const done = finished(manager, run.id);
      manager.cancelRun(run.id);
      await done;
      expect(manager.getRun(run.id).status).toBe('cancelled');
    } finally {
      await manager.shutdown();
      vi.useRealTimers();
    }
  });

  it('continues past the previous step and conversation length limits', async () => {
    const manager = managerFor({
      async *stream(messages) {
        for (let index = 0; index < (messages.length === 1 ? 210 : 0); index++) {
          yield { type: 'tool.start', id: `step-${index}`, name: 'read', input: '{}' };
          yield { type: 'tool.end', id: `step-${index}`, output: 'ok', failed: false };
        }
        yield { type: 'text.delta', text: '完成' };
      },
    });
    const thread = manager.createThread();
    for (let index = 0; index < 101; index++) {
      const run = manager.startRun(thread.id, '继续');
      await finished(manager, run.id);
      expect(manager.getRun(run.id).status).toBe('succeeded');
    }
    expect(manager.getThread(thread.id).messages).toHaveLength(202);
  });
});
