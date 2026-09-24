import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { AgentTask } from '@flux-agent/contracts';
import { createDelegateTool } from '../src/agents/delegate-tasks.js';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import type { AgentEvent, AgentExecutionContext } from '../src/agents/agent-runtime.js';

afterEach(() => vi.restoreAllMocks());
const input = {
  tasks: [
    { name: '分析', task: '分析模块' },
    { name: '审查', task: '审查模块' },
  ],
};
function context(snapshots: Map<string, AgentTask>): AgentExecutionContext {
  return {
    workspacePath: '/workspace',
    permissionMode: 'read-only',
    recordSubagent: (task) => snapshots.set(task.id, task),
    async *execute() {
      return { content: '文件内容', failed: false };
    },
  };
}

describe('Subagent orchestration', () => {
  it.each([
    [401, '鉴权失败'],
    [429, '请求受限'],
    [503, 'HTTP 503'],
    [400, '思考上下文格式'],
  ])('reports model failure HTTP %s without exposing provider details', async (status, expected) => {
    const snapshots = new Map<string, AgentTask>();
    const tool = createDelegateTool(
      context(snapshots),
      new AbortController().signal,
      () => ({
        async *stream() {
          throw Object.assign(new Error('reasoning_content private-provider-key'), { status });
        },
      }),
      () => {},
    );
    await tool.invoke({
      type: 'tool_call',
      id: 'delegation',
      name: 'delegate_tasks',
      args: { mode: 'parallel', tasks: [input.tasks[0]!] },
    });
    const child = [...snapshots.values()][0]!;
    expect(child).toMatchObject({ status: 'failed', parentToolCallId: 'delegation', compression: null });
    expect(child.error).toContain(expected);
    expect(child.error).not.toContain('private-provider-key');
  });

  it('runs independent children concurrently with isolated contexts and namespaced tool IDs', async () => {
    const snapshots = new Map<string, AgentTask>();
    const execution = context(snapshots);
    const ids: string[] = [];
    execution.execute = async function* (request) {
      ids.push(request.id);
      return { content: '文件', failed: false };
    };
    const started = Promise.withResolvers<void>();
    let active = 0;
    const tool = createDelegateTool(
      execution,
      new AbortController().signal,
      () => ({
        async *stream(messages, signal, child) {
          expect(child!.permissionMode).toBe('read-only');
          expect(child!.recordSubagent).toBeUndefined();
          expect(child!.getPlan).toBeUndefined();
          expect(messages).toHaveLength(1);
          if (++active === 2) started.resolve();
          await started.promise;
          const call = child!.execute({ id: 'same-provider-id', name: 'read_file', input: { path: 'a' } }, signal);
          await call.next();
          child!.saveMessages!([...messages, { role: 'assistant', content: '独立完成' }]);
          yield { type: 'text.delta', text: '独立完成' };
        },
      }),
      () => {},
    );
    const result = await tool.invoke({
      type: 'tool_call',
      id: 'delegate',
      name: 'delegate_tasks',
      args: { ...input, mode: 'parallel' },
    });
    expect(new Set(ids).size).toBe(2);
    expect([...snapshots.values()].map((task) => task.status)).toEqual(['succeeded', 'succeeded']);
    expect([...snapshots.values()].every((task) => task.messages.length === 2)).toBe(true);
    expect((result as ToolMessage).status).toBe('success');
  });

  it('passes previous results to sequential children and returns failures without losing sibling results', async () => {
    const snapshots = new Map<string, AgentTask>();
    const tool = createDelegateTool(
      context(snapshots),
      new AbortController().signal,
      (task) => ({
        async *stream(messages) {
          if (task.name === '审查') {
            expect(messages[0]!.content).toContain('分析结论');
            throw new Error('private-provider-key');
          }
          yield { type: 'text.delta', text: '分析结论' };
        },
      }),
      () => {},
    );
    const result = await tool.invoke({
      type: 'tool_call',
      id: 'delegate',
      name: 'delegate_tasks',
      args: { ...input, mode: 'sequential' },
    });
    expect([...snapshots.values()].map((task) => task.status)).toEqual(['succeeded', 'failed']);
    expect((result as ToolMessage).status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('private-provider-key');
  });

  it('cancels every child and waits for cleanup before delegation exits', async () => {
    const snapshots = new Map<string, AgentTask>();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let active = 0;
    let cleaned = 0;
    const tool = createDelegateTool(
      context(snapshots),
      controller.signal,
      () => ({
        async *stream(_messages, signal) {
          if (++active === 2) started.resolve();
          try {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            signal.throwIfAborted();
          } finally {
            cleaned++;
          }
        },
      }),
      () => {},
    );
    const work = tool.invoke({
      type: 'tool_call',
      id: 'delegate',
      name: 'delegate_tasks',
      args: { ...input, mode: 'parallel' },
    });
    const rejection = expect(work).rejects.toThrow();
    await started.promise;
    controller.abort();
    await rejection;
    expect(cleaned).toBe(2);
    expect([...snapshots.values()].every((task) => task.status === 'cancelled')).toBe(true);
  });

  it('keeps child text out of the parent answer while streaming real nested LangChain agents', async () => {
    const snapshots = new Map<string, AgentTask>();
    vi.spyOn(FakeStreamingChatModel.prototype, '_streamResponseChunks').mockImplementation(
      async function* (messages, _options, manager) {
        const child = String(messages[0]?.content).includes('你是子 Agent');
        const message = child
          ? new AIMessageChunk('子 Agent 结果')
          : messages.at(-1)?.getType() === 'tool'
            ? new AIMessageChunk('主 Agent 汇总')
            : new AIMessageChunk({
                content: '',
                tool_calls: [
                  { id: 'delegate', name: 'delegate_tasks', args: { ...input, mode: 'parallel' }, type: 'tool_call' },
                ],
              });
        const chunk = new ChatGenerationChunk({ message, text: String(message.content) });
        yield chunk;
        await manager?.handleLLMNewToken(String(message.content), undefined, undefined, undefined, undefined, {
          chunk,
        });
      },
    );
    const runtime = new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks: [] }), {
      name: 'supervisor',
      systemPrompt: '拆分任务并汇总',
    });
    const events: AgentEvent[] = [];
    for await (const event of runtime.stream(
      [{ role: 'user', content: '多 Agent 分析' }],
      new AbortController().signal,
      context(snapshots),
    ))
      events.push(event);
    expect(events.filter((event) => event.type === 'text.delta')).toEqual([
      { type: 'text.delta', text: '主 Agent 汇总' },
    ]);
    expect([...snapshots.values()].map((task) => task.output)).toEqual(['子 Agent 结果', '子 Agent 结果']);
  });
});
