import { describe, expect, it } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { ModelMessage, SteeringMessage } from '@flux-agent/contracts';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import { buildContext } from '../src/context/context-builder.js';
import { decodeMessage, encodeMessages } from '../src/context/message-codec.js';

describe('Same-task steering', () => {
  it.each(['tool', 'answer'])(
    'consumes messages arriving during %s without replaying tools or losing the original task',
    async (phase) => {
      const chunks = [
        phase === 'tool'
          ? new AIMessageChunk({
              content: '',
              tool_calls: [
                {
                  id: 'write-once',
                  name: 'write_file',
                  args: { path: 'hello.txt', content: 'hello' },
                  type: 'tool_call',
                },
              ],
            })
          : new AIMessageChunk('原回答'),
      ];
      const runtime = new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks }), {
        name: 'steering',
        systemPrompt: '完成任务。',
      });
      const pending: SteeringMessage[] = [];
      const applied: string[] = [];
      let saved: ModelMessage[] = [];
      let modelCalls = 0;
      let toolCalls = 0;
      let closed = false;
      const enqueue = () => {
        for (const content of ['改为中文', '只给出摘要'])
          pending.push({
            id: crypto.randomUUID(),
            content,
            status: 'pending',
            createdAt: new Date().toISOString(),
            appliedAt: null,
          });
      };
      for await (const _event of runtime.stream([{ role: 'user', content: '原始任务' }], new AbortController().signal, {
        permissionMode: 'workspace-write',
        workspacePath: '/test',
        recordContext: () => {
          if (++modelCalls === 1 && phase === 'answer') enqueue();
        },
        saveMessages: (messages) => {
          saved = messages;
        },
        steering: {
          pending: () => structuredClone(pending),
          apply: (ids) => {
            for (const message of pending) if (ids.includes(message.id)) applied.push(message.id);
            if (pending.length && pending.every((message) => ids.includes(message.id))) {
              pending.splice(0);
              chunks.splice(0, chunks.length, new AIMessageChunk('调整后的摘要'));
            }
          },
          finish: () => {
            closed = pending.length === 0;
            return closed;
          },
        },
        async *execute() {
          toolCalls++;
          enqueue();
          return { content: 'written', failed: false };
        },
      })) {
        /* 完整消费模型流，确认 afterModel 能继续执行。 */
      }
      expect(modelCalls).toBe(2);
      expect(toolCalls).toBe(phase === 'tool' ? 1 : 0);
      expect(closed).toBe(true);
      expect(applied).toHaveLength(2);
      expect(saved.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
        '原始任务',
        '改为中文',
        '只给出摘要',
      ]);
      expect(
        saved.filter((message) => message.role === 'user' && message.steeringId).map((message) => message.steeringId),
      ).toEqual(applied);
      expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: '调整后的摘要' });
      expect(encodeMessages(saved.map(decodeMessage))).toEqual(saved);
    },
  );

  it('keeps the original objective and tool pairs with steering even beyond the reference budget', () => {
    const current: ModelMessage[] = [
      { role: 'user', content: '目标'.repeat(2000) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', args: {} }] },
      { role: 'tool', toolCallId: 'read', content: '文件内容' },
      { role: 'user', content: '关注权限', steeringId: crypto.randomUUID() },
    ];
    const context = buildContext(
      [{ role: 'user', content: '旧任务' }, { role: 'assistant', content: '旧回答' }, ...current],
      '',
      [],
      [],
      { contextWindowTokens: 1000, maxOutputTokens: 256 },
      2,
    );
    expect(context.messages).toEqual(current);
    expect(context.record).toMatchObject({ keptTurns: 1, omittedTurns: 1 });
  });
});
