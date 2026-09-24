import { describe, expect, it, vi } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { ContextCompaction, ModelMessage } from '@flux-agent/contracts';
import { ContextCompressor, isContextOverflow } from '../src/context/context-compressor.js';

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
