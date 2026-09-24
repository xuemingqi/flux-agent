import { describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import type { AgentEvent } from '../src/agents/agent-runtime.js';
import type { ContextRecord, ModelMessage } from '@flux-agent/contracts';
import { ContextBudgetError } from '../src/context/context-builder.js';
import { ModelOutputLimitError } from '../src/models/model-output-limit-error.js';
import { ChatGenerationChunk } from '@langchain/core/outputs';

describe('LangChain process streaming', () => {
  it('reports an exhausted reasoning budget explicitly and saves its finish reason', async () => {
    const model = new FakeStreamingChatModel({ chunks: [] });
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    vi.spyOn(model, '_streamResponseChunks').mockImplementation(async function* (_messages, _options, manager) {
      const chunk = new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          additional_kwargs: { reasoning_content: '尚在思考，正文未生成。' },
          response_metadata: { finish_reason: 'length' },
        }),
      });
      yield chunk;
      await manager?.handleLLMNewToken('', undefined, undefined, undefined, undefined, { chunk });
    });
    const runtime = new LangChainAgentRuntime(model, { name: 'debater', systemPrompt: '辩论' });
    let saved: ModelMessage[] = [];
    const consume = async () => {
      for await (const _event of runtime.stream([{ role: 'user', content: '开始' }], new AbortController().signal, {
        workspacePath: '/test',
        permissionMode: 'read-only',
        saveMessages: (messages) => {
          saved = messages;
        },
        async *execute() {
          throw new Error('No tools');
        },
      })) {
        /* Consume the real graph until the model reports truncation. */
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ModelOutputLimitError);
    expect(saved.at(-1)).toMatchObject({ content: '', finishReason: 'length' });
  });
  it('preserves a typed invalid-history error across middleware wrapping', async () => {
    const runtime = new LangChainAgentRuntime(
      new FakeStreamingChatModel({ chunks: [new AIMessageChunk('must not run')] }),
      { name: 'small', systemPrompt: 'Read.' },
      { contextWindowTokens: 8192 },
    );
    const consume = async () => {
      for await (const _event of runtime.stream(
        [
          { role: 'user', content: '读取文件' },
          { role: 'tool', toolCallId: 'missing-call', content: '未配对的工具结果' },
        ],
        new AbortController().signal,
      )) {
        throw new Error('无效工具历史不应调用模型');
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ContextBudgetError);
  });

  it('finishes repeated file reads even when the current turn exceeds the estimated context budget', async () => {
    const fileCall = (index: number) =>
      new AIMessageChunk({
        content: '',
        tool_calls: [
          { id: `read-${index}`, name: 'read_file', args: { path: `file-${index}.txt` }, type: 'tool_call' },
        ],
      });
    const chunks = [fileCall(0)];
    const model = new FakeStreamingChatModel({ chunks });
    const stream = model.stream.bind(model);
    const summary = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk('已读取项目文件，继续按用户要求分析。')],
    });
    vi.spyOn(model, 'stream').mockImplementation((input, config) =>
      config?.metadata?.flux_compaction ? summary.stream(input, config) : stream(input, config),
    );
    const runtime = new LangChainAgentRuntime(model, {
      name: 'project-analysis',
      systemPrompt: '读取文件后总结。',
    });
    const events: AgentEvent[] = [];
    const contexts: ContextRecord[] = [];
    let saved: ModelMessage[] = [];
    let count = 0;
    for await (const event of runtime.stream(
      [{ role: 'user', content: '分析这个项目' }],
      new AbortController().signal,
      {
        permissionMode: 'read-only',
        workspacePath: '/test',
        recordContext: (record) => contexts.push(record),
        saveMessages: (messages) => {
          saved = messages;
        },
        async *execute() {
          count++;
          chunks.splice(0, chunks.length, count < 65 ? fileCall(count) : new AIMessageChunk('项目分析完成'));
          return { content: '中文'.repeat(1500), failed: false };
        },
      },
    ))
      events.push(event);
    expect(count).toBe(65);
    expect(contexts).toHaveLength(66);
    expect(contexts.at(-1)!.estimatedTokens).toBeLessThan(contexts.at(-1)!.budgetTokens);
    expect(contexts.at(-1)!.summarizedMessages).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'tool.end')).toHaveLength(65);
    expect(events.at(-1)).toEqual({ type: 'text.delta', text: '项目分析完成' });
    expect(saved.filter((message) => message.role === 'tool')).toHaveLength(65);
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: '项目分析完成' });
  });
  it('binds host permissions per run and keeps the native tool call ID and error status', async () => {
    const chunks = [
      new AIMessageChunk({
        content: '',
        tool_calls: [{ id: 'file-call', name: 'read_file', args: { path: 'hello.txt' }, type: 'tool_call' }],
      }),
    ];
    const runtime = new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks }), {
      name: 'scoped',
      systemPrompt: 'Read.',
    });
    const events: AgentEvent[] = [];
    const contexts: ContextRecord[] = [];
    let saved: ModelMessage[] = [];
    for await (const event of runtime.stream([{ role: 'user', content: '读取' }], new AbortController().signal, {
      permissionMode: 'read-only',
      workspacePath: '/test',
      recordContext: (record) => contexts.push(record),
      saveMessages: (messages) => {
        saved = messages;
      },
      async *execute(request) {
        expect(request).toEqual({ id: 'file-call', name: 'read_file', input: { path: 'hello.txt' } });
        yield '读取真实文件';
        chunks.splice(0, chunks.length, new AIMessageChunk('结束'));
        return { content: 'PATH_DENIED', failed: true };
      },
    }))
      events.push(event);
    expect(events).toContainEqual({ type: 'tool.progress', id: 'file-call', text: '读取真实文件' });
    expect(events).toContainEqual({ type: 'tool.end', id: 'file-call', output: 'PATH_DENIED', failed: true });
    expect(events.at(-1)).toEqual({ type: 'text.delta', text: '结束' });
    expect(contexts.map((record) => record.step)).toEqual([1, 2]);
    expect(saved.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(saved[1]).toMatchObject({
      toolCalls: [{ id: 'file-call', name: 'read_file', args: { path: 'hello.txt' } }],
    });
    expect(saved[2]).toMatchObject({ toolCallId: 'file-call', content: 'PATH_DENIED', status: 'error' });
    const previous = saved;
    for await (const _event of runtime.stream(
      [...previous, { role: 'user', content: '继续' }],
      new AbortController().signal,
      {
        permissionMode: 'read-only',
        workspacePath: '/test',
        async *execute() {
          throw new Error('不应重复调用工具');
        },
        recordContext: (record) => contexts.push(record),
        saveMessages: (messages) => {
          saved = messages;
        },
      },
    )) {
      /* Consume the second turn. */
    }
    expect(contexts.at(-1)?.keptTurns).toBe(2);
    expect(saved).toEqual([
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '结束' },
    ]);
  });
  it.each([false, true])('streams actual tool lifecycle and sanitizes thrown errors (failure: %s)', async (fail) => {
    const chunks = [
      new AIMessageChunk({
        content: '',
        additional_kwargs: { reasoning_content: '先调用工具。' },
        tool_calls: [{ id: 'call-progress', name: 'progress_tool', args: {}, type: 'tool_call' }],
      }),
    ];
    const progressTool = tool(
      async function* () {
        yield '开始读取';
        yield '读取完成';
        chunks.splice(0, chunks.length, new AIMessageChunk('最终答复'));
        if (fail) throw new Error('private-tool-secret');
        return '真实返回结果';
      },
      { name: 'progress_tool', description: '测试流式工具', schema: { type: 'object', properties: {} } },
    );
    const runtime = new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks }), {
      name: 'process-test',
      systemPrompt: 'Use the tool.',
      tools: [progressTool],
    });
    const events: AgentEvent[] = [];
    for await (const event of runtime.stream([{ role: 'user', content: '执行' }], new AbortController().signal))
      events.push(event);
    expect(events[0]).toEqual({ type: 'reasoning.delta', text: '先调用工具。' });
    expect(events.filter((event) => event.type.startsWith('tool.'))).toEqual([
      { type: 'tool.start', id: 'call-progress', name: 'progress_tool', input: '{}' },
      { type: 'tool.progress', id: 'call-progress', text: '开始读取' },
      { type: 'tool.progress', id: 'call-progress', text: '读取完成' },
      {
        type: 'tool.end',
        id: 'call-progress',
        failed: fail,
        output: fail ? '工具执行失败，请检查参数后重试。' : '真实返回结果',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('private-tool-secret');
    expect(events.at(-1)).toEqual({ type: 'text.delta', text: '最终答复' });
  });
});
