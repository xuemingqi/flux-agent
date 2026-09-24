import { describe, expect, it, vi } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { AgentTask, ModelMessage, SteeringMessage } from '@flux-agent/contracts';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import type { SteeringInbox } from '../src/agents/agent-runtime.js';

function inbox() {
  const pending: SteeringMessage[] = [];
  const listeners = new Set<() => void>();
  const steering: SteeringInbox = {
    pending: () => structuredClone(pending),
    apply: (ids) => {
      for (let i = pending.length - 1; i >= 0; i--) if (ids.includes(pending[i]!.id)) pending.splice(i, 1);
    },
    finish: () => !pending.length,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    steering,
    send: () => {
      pending.push({
        id: crypto.randomUUID(),
        content: '处理新方向',
        status: 'pending',
        createdAt: '',
        appliedAt: null,
      });
      listeners.forEach((listener) => listener());
    },
  };
}

describe('Steering execution boundaries', () => {
  it('aborts unfinished answer generation and answers the new input without waiting for the old stream to finish', async () => {
    const model = new FakeStreamingChatModel({ chunks: [] });
    let aborted = false;
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    vi.spyOn(model, '_streamResponseChunks').mockImplementation(async function* (messages, options, manager) {
      const text = messages.at(-1)?.content === '处理新方向' ? '新方向答复' : '旧回答片段';
      const chunk = new ChatGenerationChunk({ message: new AIMessageChunk(text), text });
      yield chunk;
      await manager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
      if (text === '旧回答片段') {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = true;
        options.signal?.throwIfAborted();
      }
    });
    const input = inbox();
    const runtime = new LangChainAgentRuntime(model, { name: 'steer-stream', systemPrompt: '回答问题' });
    let history: ModelMessage[] = [];
    const output: string[] = [];
    for await (const event of runtime.stream([{ role: 'user', content: '原任务' }], new AbortController().signal, {
      permissionMode: 'read-only',
      workspacePath: '/test',
      steering: input.steering,
      saveMessages: (messages) => {
        history = messages;
      },
      async *execute() {
        throw new Error('No tools expected');
      },
    })) {
      if (event.type !== 'text.delta') continue;
      output.push(event.text);
      if (event.text === '旧回答片段') input.send();
    }
    expect(aborted).toBe(true);
    expect(output.at(-1)).toBe('新方向答复');
    expect(history.map((message) => message.content)).toEqual([
      '原任务',
      '旧回答片段\n[回答被用户调整打断，尚未完成。]',
      '处理新方向',
      '新方向答复',
    ]);
  });

  it('finishes the started tool once and skips the next queued tool before handling steering', async () => {
    const chunks = [
      new AIMessageChunk({
        content: '',
        tool_calls: ['first', 'second'].map((id) => ({
          id,
          name: 'write_file',
          args: { path: `${id}.txt`, content: id },
          type: 'tool_call' as const,
        })),
      }),
    ];
    const model = new FakeStreamingChatModel({ chunks });
    const runtime = new LangChainAgentRuntime(model, { name: 'steer-tools', systemPrompt: '执行' });
    const input = inbox();
    const calls: string[] = [];
    let completed = false;
    let history: ModelMessage[] = [];
    for await (const _event of runtime.stream([{ role: 'user', content: '原任务' }], new AbortController().signal, {
      permissionMode: 'workspace-write',
      workspacePath: '/test',
      steering: input.steering,
      saveMessages: (messages) => {
        history = messages;
      },
      async *execute(request, signal) {
        calls.push(request.id);
        input.send();
        await Promise.resolve();
        expect(signal.aborted).toBe(false);
        completed = true;
        chunks.splice(0, chunks.length, new AIMessageChunk('新方向答复'));
        return { content: '写入完成', failed: false };
      },
    })) {
      /* Consume until the adjusted answer completes. */
    }
    expect(completed).toBe(true);
    expect(calls).toEqual(['first']);
    expect(history.find((message) => message.role === 'tool' && message.toolCallId === 'second')?.content).toContain(
      '尚未执行',
    );
    expect(history.at(-1)?.content).toBe('新方向答复');
  });

  it('lets a child finish its current tool, skips remaining work and returns completed effects with the new direction', async () => {
    const model = new FakeStreamingChatModel({ chunks: [] });
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    let childRequests = 0;
    vi.spyOn(model, '_streamResponseChunks').mockImplementation(async function* (messages, _options, manager) {
      const child = String(messages[0]?.content).includes('你是子 Agent');
      if (child) childRequests++;
      const message = child
        ? new AIMessageChunk({
            content: '',
            tool_calls: ['first', 'second'].map((id) => ({
              id,
              name: 'write_file',
              args: { path: `${id}.txt`, content: id },
              type: 'tool_call' as const,
            })),
          })
        : messages.at(-1)?.content === '处理新方向'
          ? new AIMessageChunk('新方向答复')
          : new AIMessageChunk({
              content: '',
              tool_calls: [
                {
                  id: 'delegate',
                  name: 'delegate_tasks',
                  args: {
                    mode: 'sequential',
                    tasks: [
                      { name: '实现', task: '写入文件' },
                      { name: '审查', task: '审查文件' },
                    ],
                  },
                  type: 'tool_call',
                },
              ],
            });
      const chunk = new ChatGenerationChunk({ message, text: String(message.content) });
      yield chunk;
      await manager?.handleLLMNewToken(String(message.content), undefined, undefined, undefined, undefined, { chunk });
    });
    const input = inbox();
    const snapshots = new Map<string, AgentTask>();
    const calls: unknown[] = [];
    let history: ModelMessage[] = [];
    const runtime = new LangChainAgentRuntime(model, { name: 'supervisor', systemPrompt: '执行后汇总' });
    for await (const _event of runtime.stream([{ role: 'user', content: '原任务' }], new AbortController().signal, {
      permissionMode: 'workspace-write',
      workspacePath: '/test',
      steering: input.steering,
      recordSubagent: (task) => snapshots.set(task.id, task),
      saveMessages: (messages) => {
        history = messages;
      },
      async *execute(request, signal) {
        calls.push(request.input);
        input.send();
        await Promise.resolve();
        expect(signal.aborted).toBe(false);
        return { content: 'first.txt 写入完成', failed: false };
      },
    })) {
      /* Consume until the parent handles the new message. */
    }
    expect(calls).toEqual([{ path: 'first.txt', content: 'first' }]);
    expect(childRequests).toBe(1);
    expect([...snapshots.values()].map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
    expect([...snapshots.values()][0]!.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
    expect(history.find((message) => message.role === 'tool')?.content).toContain('first.txt 写入完成');
    expect(history.at(-1)?.content).toBe('新方向答复');
  });
});
