import { describe, expect, it, vi } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { ContextCompaction, MemoryEntry, ModelMessage } from '@flux-agent/contracts';
import { ContextCompressor, isContextOverflow } from '../src/context/context-compressor.js';
import { buildContext, estimate } from '../src/context/context-builder.js';

const history: ModelMessage[] = [
  { role: 'user', content: '记住任务代号 orchid，先读文件。' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', args: { path: 'a.txt' } }] },
  { role: 'tool', toolCallId: 'read', content: '具体内容'.repeat(3000) },
  { role: 'assistant', content: '文件已经读取。' },
  { role: 'user', content: '现在任务代号是什么？' },
];
const model = () =>
  new FakeStreamingChatModel({
    chunks: [new AIMessageChunk('用户任务代号是 orchid，a.txt 已读取，等待汇总。')],
    sleep: 0,
  });

describe('Durable context compaction', () => {
  it('waits until 90 percent of the configured window instead of applying two discounts', async () => {
    const chat = model();
    const summarize = vi.spyOn(chat, 'stream');
    const budget = { contextWindowTokens: 10000 };
    const compressor = new ContextCompressor(chat, budget);
    const messages: ModelMessage[] = [
      { role: 'user', content: '原始目标' },
      { role: 'assistant', content: 'x'.repeat(25000) },
      { role: 'user', content: '继续' },
    ];
    const before = await compressor.prepare(messages, '', [], [], 1, new AbortController().signal);
    expect(before.record.budgetTokens).toBe(9000);
    expect(before.record.estimatedTokens).toBeGreaterThan(8000);
    expect(summarize).not.toHaveBeenCalled();
    messages[1]!.content += 'x'.repeat(4000);
    const after = await compressor.prepare(messages, '', [], [], 2, new AbortController().signal);
    expect(summarize).toHaveBeenCalled();
    expect(after.record.estimatedTokens).toBeLessThanOrEqual(2000);
  });

  it('uses the complete request for the 20 percent target and does not summarize again without new history', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: '保留当前任务的完整要求' }];
    for (let index = 0; index < 12; index++) {
      messages.push(
        { role: 'assistant', content: '', toolCalls: [{ id: String(index), name: 'read_file', args: {} }] },
        { role: 'tool', toolCallId: String(index), content: 'x'.repeat(3000) },
      );
    }
    const system = '约束'.repeat(70);
    const tools = [{ name: 'read_file', description: 'x'.repeat(300) }];
    const memory = { id: 'm', version: 1, content: '记忆'.repeat(30) } as MemoryEntry;
    const budget = { contextWindowTokens: 10000 };
    const chat = model();
    const summarize = vi.spyOn(chat, 'stream');
    const save = vi.fn();
    const compressor = new ContextCompressor(chat, budget, null, save);
    const after = await compressor.prepare(messages, system, tools, [memory], 1, new AbortController().signal);
    expect(after.record.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(after.record.memories).toHaveLength(1);
    expect(after.messages).toContainEqual(messages[0]);
    expect(after.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(save.mock.calls[0]![0]).toMatchObject({ targetTokens: 2000 });
    const calls = summarize.mock.calls.length;
    await compressor.prepare(messages, system, tools, [memory], 2, new AbortController().signal);
    expect(summarize).toHaveBeenCalledTimes(calls);
  });

  it('reports when the latest indivisible tool result prevents reaching the target', async () => {
    const messages: ModelMessage[] = [
      ...history.slice(0, 3),
      { role: 'assistant', content: '', toolCalls: [{ id: 'latest', name: 'read_file', args: {} }] },
      { role: 'tool', toolCallId: 'latest', content: 'z'.repeat(9000) },
    ];
    const save = vi.fn();
    const compressor = new ContextCompressor(model(), { contextWindowTokens: 10000 }, null, save);
    const after = await compressor.prepare(messages, '', [], [], 1, new AbortController().signal);
    expect(after.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(after.record.estimatedTokens).toBeGreaterThan(2000);
    expect(save.mock.calls[0]![0].warning).toContain('20%');
  });

  it('does not repeatedly summarize instructions that must be restored beside an oversized latest result', async () => {
    const chat = model();
    const summarize = vi.spyOn(chat, 'stream');
    const compressor = new ContextCompressor(chat, { contextWindowTokens: 8192 });
    const messages = history.slice(0, 3);
    for (let step = 1; step <= 2; step++) {
      const result = await compressor.prepare(messages, '', [], [], step, new AbortController().signal);
      expect(result.messages).toEqual(messages);
      expect(result.record.compressionWarning).toContain('没有可安全压缩');
    }
    expect(summarize).not.toHaveBeenCalled();
  });

  it('retries an oversized summary once and retains raw history if the model still ignores the budget', async () => {
    const chat = new FakeStreamingChatModel({ chunks: [new AIMessageChunk('长摘要'.repeat(500))], sleep: 0 });
    const summarize = vi.spyOn(chat, 'stream');
    const save = vi.fn();
    const compressor = new ContextCompressor(chat, { contextWindowTokens: 8192 }, null, save);
    const after = await compressor.prepare(history, '', [], [], 1, new AbortController().signal);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(after.messages).toEqual(history);
    expect(after.record.compressionError).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('still forces compression after a provider overflow below the estimated threshold', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a'.repeat(3000) },
      { role: 'assistant', content: '已完成' },
      { role: 'user', content: '继续' },
    ];
    const budget = { contextWindowTokens: 32768 };
    expect(buildContext(messages, '', [], [], budget, 1).record.estimatedTokens).toBeLessThan(32768 * 0.9);
    const compressor = new ContextCompressor(model(), budget);
    const after = await compressor.prepare(messages, '', [], [], 1, new AbortController().signal, true);
    expect(after.record.summarizedMessages).toBe(2);
    expect(estimate(after.messages)).toBeLessThan(estimate(messages));
  });

  it('does not summarize an ordinary first question with a file read far below the model window', async () => {
    const chat = model();
    const invoke = vi.spyOn(chat, 'stream');
    const messages: ModelMessage[] = [
      { role: 'user', content: '介绍项目，给出证据。' },
      history[1]!,
      { ...history[2]!, content: 'const value = 123; // 项目说明\n'.repeat(600) },
    ];
    const compressor = new ContextCompressor(chat, { contextWindowTokens: 32768 });
    const prepared = await compressor.prepare(messages, '只读', [], [], 1, new AbortController().signal);
    expect(invoke).not.toHaveBeenCalled();
    expect(prepared.record.summarizedMessages).toBe(0);
    expect(prepared.messages).toEqual(messages);
  });

  it('keeps the exact current task and steering after a lossy summary and preserves the latest tool result', async () => {
    const task: ModelMessage = { role: 'user', content: '只核对五个参数，输出参数、实际值、路径行号和一致性表。' };
    const steering: ModelMessage = { role: 'user', content: '不要扩大范围，不要修改文件。', steeringId: 'adjust' };
    const messages: ModelMessage[] = [
      task,
      history[1]!,
      history[2]!,
      steering,
      { role: 'assistant', content: '', toolCalls: [{ id: 'last', name: 'read_file', args: {} }] },
      { role: 'tool', toolCallId: 'last', content: '最新工具证据，保留完整内容。' },
    ];
    const chat = model();
    const compressor = new ContextCompressor(chat, { contextWindowTokens: 8192, maxOutputTokens: 512 });
    const prepared = await compressor.prepare(messages, '只读', [], [], 1, new AbortController().signal);
    expect(prepared.record.summarizedMessages).toBeGreaterThan(0);
    expect(prepared.messages).toContainEqual(task);
    expect(prepared.messages).toContainEqual(steering);
    expect(prepared.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(prepared.messages.filter((message) => message === steering)).toHaveLength(1);
  });

  it('compacts long history without deleting raw messages and reuses the saved summary in the next turn', async () => {
    let checkpoint: ContextCompaction | null = null;
    const chat = model();
    const invoke = vi.spyOn(chat, 'stream');
    const progress = vi.fn();
    const compressor = new ContextCompressor(
      chat,
      { contextWindowTokens: 8192, maxOutputTokens: 512 },
      null,
      (value) => {
        checkpoint = value;
      },
      progress,
    );
    const original = structuredClone(history);
    const result = await compressor.prepare(history, '只读', [], [], 1, new AbortController().signal);
    expect(checkpoint).not.toBeNull();
    expect(result.messages[0]?.content).toContain('orchid');
    expect(result.messages.at(-1)?.content).toBe('现在任务代号是什么？');
    expect(result.record.estimatedTokens).toBeLessThan(result.record.budgetTokens);
    expect(history).toEqual(original);
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false);
    const requestCount = invoke.mock.calls.length;
    expect(progress).toHaveBeenNthCalledWith(1, { completed: 0, total: requestCount });
    expect(progress).toHaveBeenCalledWith({ completed: requestCount, total: requestCount });
    expect(progress).toHaveBeenLastCalledWith(null);
    const restored = new ContextCompressor(chat, { contextWindowTokens: 8192, maxOutputTokens: 512 }, checkpoint);
    const next = await restored.prepare(
      [...history, { role: 'assistant', content: 'orchid' }, { role: 'user', content: '继续' }],
      '只读',
      [],
      [],
      1,
      new AbortController().signal,
    );
    expect(next.messages[0]?.content).toContain('orchid');
    expect(invoke).toHaveBeenCalledTimes(requestCount);
    expect(requestCount).toBeGreaterThan(1); // 过长历史分块归纳，不把超限前缀整体发送。
  });

  it('keeps original history when summary generation fails and never inserts provider errors into context', async () => {
    const chat = model();
    vi.spyOn(chat, 'stream').mockRejectedValue(new Error('private-provider-secret'));
    const save = vi.fn();
    const progress = vi.fn();
    const compressor = new ContextCompressor(
      chat,
      { contextWindowTokens: 8192, maxOutputTokens: 512 },
      null,
      save,
      progress,
    );
    const prepared = await compressor.prepare(history, '', [], [], 1, new AbortController().signal);
    expect(prepared.messages).toHaveLength(history.length);
    expect(prepared.record.compressionError).toContain('保留原文');
    expect(JSON.stringify(prepared)).not.toContain('private-provider-secret');
    expect(save).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(null);
  });

  it('cancels summary generation without committing a partial summary', async () => {
    const controller = new AbortController();
    const chat = model();
    const save = vi.fn();
    vi.spyOn(chat, 'stream').mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const compressor = new ContextCompressor(chat, { contextWindowTokens: 8192 }, null, save);
    await expect(compressor.prepare(history, '', [], [], 1, controller.signal)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('recognizes only real provider context overflow for a compression retry', () => {
    expect(isContextOverflow({ status: 400, code: 'context_length_exceeded' })).toBe(true);
    expect(isContextOverflow({ status: 401, message: 'bad key' })).toBe(false);
    expect(isContextOverflow({ status: 429, message: 'too many tokens' })).toBe(false);
  });
});
