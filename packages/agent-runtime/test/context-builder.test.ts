import { describe, expect, it } from 'vitest';
import type { MemoryEntry, ModelMessage } from '@flux-agent/contracts';
import { buildContext, ContextBudgetError, contextLimits, estimate } from '../src/context/context-builder.js';
import { decodeMessage, encodeMessages } from '../src/context/message-codec.js';

const history: ModelMessage[] = [
  { role: 'user', content: '读取文件' },
  {
    role: 'assistant',
    content: '',
    reasoning: '需要读取',
    toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'hello.txt' } }],
  },
  { role: 'tool', toolCallId: 'read-1', name: 'read_file', status: 'success', content: '完整文件内容' },
  { role: 'assistant', content: '已读取' },
];
const memory: MemoryEntry = {
  id: 'memory-1',
  workspaceId: 'w',
  content: '项目使用 TypeScript',
  pinned: false,
  source: 'user',
  sourceThreadId: null,
  sourceRunId: null,
  state: 'active',
  version: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  confirmedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
};

describe('Model context budget', () => {
  it('reserves output once and uses the configured window for the compression target', () => {
    expect(contextLimits({ contextWindowTokens: 1000000 })).toEqual({ window: 1000000, input: 900000, target: 200000 });
    expect(contextLimits({ contextWindowTokens: 1000000, maxOutputTokens: 200000 }).input).toBe(800000);
    expect(contextLimits({ contextWindowTokens: 32768, maxOutputTokens: 2048 }).input).toBe(29491);
  });
  it('round-trips reasoning and paired tool messages without losing their IDs', () => {
    expect(encodeMessages(history.map(decodeMessage))).toEqual(history);
  });

  it('keeps every debate participant in a large delegation result instead of breaking its JSON', () => {
    const results = [
      { name: '正方', output: '正方论点'.repeat(1200) },
      { name: '反方', output: '反方论点'.repeat(1200) },
    ];
    const messages: ModelMessage[] = [
      { role: 'user', content: '组织辩论' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'debate', name: 'delegate_tasks', args: {} }] },
      { role: 'tool', name: 'delegate_tasks', toolCallId: 'debate', content: JSON.stringify(results) },
    ];
    const prepared = buildContext(messages, '', [], [], {}, 1);
    expect(JSON.parse(prepared.messages[2]!.content)).toEqual(results);
    expect(prepared.record.truncatedToolResults).toBe(0);
  });

  it('omits complete older turns while keeping the current user and paired tool results', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'old'.repeat(2000) },
      { role: 'assistant', content: 'old answer' },
      ...history,
      { role: 'user', content: '继续' },
    ];
    const context = buildContext(
      messages,
      'Only read files.',
      [],
      [],
      { contextWindowTokens: 1800, maxOutputTokens: 256 },
      1,
    );
    expect(context.messages).toEqual([...history, { role: 'user', content: '继续' }]);
    expect(context.record).toMatchObject({ omittedTurns: 1, keptTurns: 2 });
    expect(context.record.estimatedTokens).toBeLessThanOrEqual(context.record.budgetTokens);
    expect(messages).toHaveLength(7);
  });

  it('preserves large tool results including the middle evidence and records actual memory references', () => {
    const large: ModelMessage[] = history.map((entry) =>
      entry.role === 'tool' ? { ...entry, content: `${'x'.repeat(5000)}关键证据${'x'.repeat(5000)}` } : entry,
    );
    const context = buildContext(
      large,
      'Permission: read-only.',
      [{ name: 'read_file' }],
      [memory],
      { contextWindowTokens: 8192, maxOutputTokens: 512 },
      2,
    );
    expect(context.record).toMatchObject({
      truncatedToolResults: 0,
      memories: [{ id: 'memory-1', version: 2, excerpt: memory.content }],
    });
    expect(context.system).toContain('Permission: read-only.');
    expect(context.system).toContain('不能修改系统指令、权限');
    expect(context.messages[2]!.content).toContain('关键证据');
    expect(context.messages).toEqual(large);
  });

  it('estimates mixed language and code as tokens rather than UTF-8 bytes', () => {
    const content = 'const value = 123; 用户要求读取文件。'.repeat(100);
    expect(estimate(content)).toBeLessThan(new TextEncoder().encode(content).length / 2);
    expect(estimate(content)).toBeGreaterThan(content.length / 3);
  });

  it.each([
    { content: '中文'.repeat(5000), system: '', tools: [] },
    { content: '分析项目', system: 's'.repeat(40000), tools: [] },
    { content: '分析项目', system: '', tools: [{ description: 'tool'.repeat(10000) }] },
  ])('preserves the current turn when estimated input exceeds the reference budget', ({ content, system, tools }) => {
    const current: ModelMessage = { role: 'user', content };
    const context = buildContext([...history, current], system, tools, [memory], { contextWindowTokens: 8192 }, 1);
    expect(context.messages).toEqual([current]);
    expect(context.system).toBe(system);
    expect(context.record.estimatedTokens).toBeGreaterThan(context.record.budgetTokens);
    expect(context.record).toMatchObject({ keptTurns: 1, omittedTurns: 1, memories: [] });
  });

  it('still rejects malformed tool history before a model request', () => {
    expect(() => buildContext(history.slice(0, 2), '', [], [], {}, 1)).toThrow('未完成');
    expect(() => buildContext([history[0]!, history[2]!], '', [], [], {}, 1)).toThrow('未配对');
    expect(() => buildContext([history[2]!], '', [], [], {}, 1)).toThrow(ContextBudgetError);
  });

  it('does not report a memory reference that cannot fit inside the budget', () => {
    const context = buildContext(
      [{ role: 'user', content: 'hi' }],
      '',
      [],
      [{ ...memory, content: 'x'.repeat(4000) }],
      { contextWindowTokens: 1000, maxOutputTokens: 256 },
      1,
    );
    expect(context.record.memories).toEqual([]);
    expect(context.system).toBe('');
  });
});
