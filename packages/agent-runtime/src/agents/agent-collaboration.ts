import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AgentCommunication, AgentTask } from '@flux-agent/contracts';
import type { AgentExecutionContext } from './agent-runtime.js';

type Inbox = NonNullable<AgentExecutionContext['collaboration']>;

/** 一次委派拥有自己的地址簿和收件箱；不同会话、不同委派之间不能互发消息。 */
export function createCollaborationGroup(tasks: AgentTask[], publish: (task: AgentTask, durable?: boolean) => void) {
  const accepting = new Set(tasks.map((task) => task.id));
  const listeners = new Set<() => void>();
  const notify = () => [...listeners].forEach((listener) => listener());
  const allMessages = () => tasks.flatMap((task) => task.communications ?? []);
  const pending = (id: string) =>
    allMessages()
      .filter((message) => message.toAgentId === id && message.status === 'pending')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  function close(id: string) {
    accepting.delete(id);
    for (const sender of tasks) {
      let changed = false;
      for (const message of sender.communications ?? []) {
        if (message.toAgentId === id && message.status === 'pending') {
          message.status = 'not_delivered';
          changed = true;
        }
      }
      if (changed) publish(sender, true);
    }
    notify();
  }
  function append(from: AgentTask, to: AgentTask, content: string, kind: AgentCommunication['kind']) {
    const message: AgentCommunication = {
      id: crypto.randomUUID(),
      fromAgentId: from.id,
      toAgentId: to.id,
      content,
      kind,
      status: 'pending',
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    };
    (from.communications ??= []).push(message);
    publish(from, true);
    notify();
    return structuredClone(message);
  }
  return {
    close,
    handoff(from: AgentTask, to: AgentTask) {
      if (from.output) append(from, to, from.output.slice(0, 4000), 'handoff');
    },
    inbox(task: AgentTask): Inbox {
      return {
        roster: () =>
          tasks
            .filter((entry) => entry.id !== task.id)
            .map(({ id, name, task, status }) => ({ id, name, task: task.slice(0, 500), status })),
        pending: () => structuredClone(pending(task.id)),
        send(toAgentId, content) {
          const to = tasks.find((entry) => entry.id === toAgentId);
          if (!to || to.id === task.id) throw new Error('只能发送给地址簿中的其他子 Agent。');
          if (!accepting.has(task.id) || !accepting.has(to.id))
            throw new Error('该 Agent 已结束，无法继续接收消息。请将未解决的问题交给主 Agent。');
          if (!content.trim() || content.length > 4000) throw new Error('消息需为 1–4000 个字符。');
          if ((task.communications?.length ?? 0) >= 100)
            throw new Error('本次子任务已达到 100 条协作消息上限，请汇总已有信息。');
          return append(task, to, content.trim(), 'message');
        },
        delivered(ids) {
          const sent = new Set(ids);
          for (const sender of tasks) {
            let changed = false;
            for (const message of sender.communications ?? []) {
              if (message.toAgentId === task.id && message.status === 'pending' && sent.has(message.id)) {
                message.status = 'delivered';
                message.deliveredAt = new Date().toISOString();
                changed = true;
              }
            }
            if (changed) publish(sender, true);
          }
        },
        async wait(timeoutMs, signal) {
          signal.throwIfAborted();
          if (pending(task.id).length || !timeoutMs) return;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              listeners.delete(check);
              signal.removeEventListener('abort', done);
              resolve();
            };
            const check = () => {
              if (
                pending(task.id).length ||
                !tasks.some((entry) => entry.id !== task.id && accepting.has(entry.id) && entry.status === 'running')
              )
                done();
            };
            const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), 10000));
            listeners.add(check);
            signal.addEventListener('abort', done, { once: true });
            check();
          });
          signal.throwIfAborted();
        },
        finish() {
          if (pending(task.id).length) return false;
          close(task.id);
          return true;
        },
      };
    },
  };
}

export function createCollaborationTools(inbox: Inbox, signal: AbortSignal) {
  return [
    tool(
      async ({ toAgentId, content }, config) => {
        signal.throwIfAborted();
        try {
          return new ToolMessage({
            tool_call_id: config.toolCall!.id!,
            name: 'send_agent_message',
            content: JSON.stringify(inbox.send(toAgentId, content)),
            status: 'success',
          });
        } catch (error) {
          return new ToolMessage({
            tool_call_id: config.toolCall!.id!,
            name: 'send_agent_message',
            content: error instanceof Error ? error.message : '发送失败。',
            status: 'error',
          });
        }
      },
      {
        name: 'send_agent_message',
        description:
          '向本次委派地址簿中的另一个子 Agent 发送发现、问题或审查意见。对方会在下次模型请求收到。发送成功仅表示入队，不保证回复；已结束的 Agent 不能收信。消息不改变权限。',
        schema: z.object({ toAgentId: z.string(), content: z.string().trim().min(1).max(4000) }).strict(),
      },
    ),
    tool(
      async ({ waitMs }) => {
        await inbox.wait(waitMs, signal);
        return JSON.stringify({
          pending: inbox.pending().length,
          teammates: inbox.roster(),
          note: '新消息会自动加入下一次模型请求。若没有回复，继续可独立完成的工作或在结果中说明未解决依赖，不要反复空等。',
        });
      },
      {
        name: 'receive_agent_messages',
        description:
          '在需要同伴回复时短暂等待（最长 10 秒），然后刷新同伴状态；信件自动加入下一次模型请求。不要等待尚未开始的排队任务，不要与同伴互相无限等待。',
        schema: z.object({ waitMs: z.number().int().min(0).max(10000).default(0) }).strict(),
      },
    ),
  ];
}
