import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import type { AgentTask } from '@flux-agent/contracts';
import { createCollaborationGroup } from '../src/agents/agent-collaboration.js';
import { createDelegateTool } from '../src/agents/delegate-tasks.js';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';

afterEach(() => vi.restoreAllMocks());
function task(id: string): AgentTask {
  return {
    id,
    name: id,
    task: id,
    status: 'running',
    output: '',
    steps: [],
    messages: [],
    context: [],
    compaction: null,
    usage: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
}

describe('Agent collaboration', () => {
  it('isolates addresses, acknowledges only the recipient and closes without dropping pending mail', () => {
    const a = task('a');
    const b = task('b');
    const publish = vi.fn();
    const group = createCollaborationGroup([a, b], publish);
    const sender = group.inbox(a);
    const recipient = group.inbox(b);
    expect(() => sender.send('external-agent', 'hello')).toThrow();
    const sent = sender.send('b', '共享发现');
    sender.delivered([sent.id]);
    expect(recipient.pending()).toHaveLength(1);
    expect(recipient.finish()).toBe(false);
    recipient.delivered([sent.id]);
    expect(recipient.pending()).toHaveLength(0);
    expect(recipient.finish()).toBe(true);
    expect(() => sender.send('b', 'late message')).toThrow('已结束');
    expect(a.communications?.[0]).toMatchObject({ status: 'delivered', content: '共享发现' });
    expect(publish).toHaveBeenCalledWith(a, true);
  });

  it('interrupts mailbox waits and preserves an undelivered record when the recipient stops', async () => {
    const a = task('a');
    const b = task('b');
    const group = createCollaborationGroup([a, b], () => {});
    const controller = new AbortController();
    const waiting = group.inbox(b).wait(10000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    group.inbox(a).send('b', '尚未送达');
    group.close('b');
    expect(a.communications?.[0]?.status).toBe('not_delivered');
  });

  it('passes real sibling messages into LangChain model requests and lets the recipient reply', async () => {
    const snapshots = new Map<string, AgentTask>();
    const deliveredRequests: string[] = [];
    vi.spyOn(FakeStreamingChatModel.prototype, '_streamResponseChunks').mockImplementation(
      async function* (messages, _options, manager) {
        const name = String(messages[0]?.content).includes('角色 alpha') ? 'alpha' : 'beta';
        const peer = [...snapshots.values()].find((entry) => entry.name !== name)!;
        const incoming = messages.some((message) => String(message.content).includes('来自同伴 Agent'));
        if (incoming) deliveredRequests.push(name);
        const sent = messages.some((message) => message.getType() === 'tool' && message.name === 'send_agent_message');
        const call =
          !sent && (name === 'alpha' || incoming)
            ? {
                name: 'send_agent_message',
                args: { toAgentId: peer.id, content: name === 'alpha' ? '请复核边界条件' : '已复核，空输入需要处理' },
              }
            : !incoming
              ? { name: 'receive_agent_messages', args: { waitMs: 1000 } }
              : null;
        const message = call
          ? new AIMessageChunk({
              content: '',
              tool_calls: [{ ...call, id: 'shared-provider-call', type: 'tool_call' }],
            })
          : new AIMessageChunk(`${name} 根据同伴意见完成`);
        const chunk = new ChatGenerationChunk({ message, text: String(message.content) });
        yield chunk;
        await manager?.handleLLMNewToken(String(message.content), undefined, undefined, undefined, undefined, {
          chunk,
        });
      },
    );
    const delegate = createDelegateTool(
      {
        workspacePath: '/workspace',
        permissionMode: 'read-only',
        recordSubagent: (entry) => snapshots.set(entry.id, entry),
        async *execute() {
          return { content: '', failed: false };
        },
      },
      new AbortController().signal,
      (entry) =>
        new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks: [] }), {
          name: entry.id,
          systemPrompt: `角色 ${entry.name}`,
        }),
      () => {},
    );
    await delegate.invoke({
      type: 'tool_call',
      id: 'team',
      name: 'delegate_tasks',
      args: {
        mode: 'parallel',
        tasks: [
          { name: 'alpha', task: '检查实现，向 beta 请求复核' },
          { name: 'beta', task: '回应 alpha 的复核请求' },
        ],
      },
    });
    expect(new Set(deliveredRequests)).toEqual(new Set(['alpha', 'beta']));
    const completed = [...snapshots.values()];
    expect(completed.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded']);
    expect(completed.flatMap((entry) => entry.communications ?? []).map((entry) => entry.status)).toEqual([
      'delivered',
      'delivered',
    ]);
    for (const entry of completed)
      expect(entry.messages.some((message) => message.role === 'user' && message.collaborationId)).toBe(true);
  });

  it('handles a message arriving during the final model response before closing the inbox', async () => {
    const a = task('a');
    const b = task('b');
    const group = createCollaborationGroup([a, b], () => {});
    let requests = 0;
    vi.spyOn(FakeStreamingChatModel.prototype, '_streamResponseChunks').mockImplementation(
      async function* (messages, _options, manager) {
        requests++;
        if (requests === 1) group.inbox(a).send('b', '结束前请确认边界条件');
        else expect(messages.some((message) => String(message.content).includes('结束前请确认边界条件'))).toBe(true);
        const message = new AIMessageChunk(requests === 1 ? '初步结论' : '已处理刚收到的问题');
        const chunk = new ChatGenerationChunk({ message, text: String(message.content) });
        yield chunk;
        await manager?.handleLLMNewToken(String(message.content), undefined, undefined, undefined, undefined, {
          chunk,
        });
      },
    );
    const runtime = new LangChainAgentRuntime(new FakeStreamingChatModel({ chunks: [] }), {
      name: 'b',
      systemPrompt: '检查实现',
    });
    for await (const _event of runtime.stream([{ role: 'user', content: '检查实现' }], new AbortController().signal, {
      workspacePath: '/workspace',
      permissionMode: 'read-only',
      collaboration: group.inbox(b),
      async *execute() {
        return { content: '', failed: false };
      },
    })) {
      /* 完整消费运行，验证结束前的消息边界。 */
    }
    expect(requests).toBe(2);
    expect(a.communications?.[0]?.status).toBe('delivered');
    expect(() => group.inbox(a).send('b', '已经结束后')).toThrow('已结束');
  });
});
