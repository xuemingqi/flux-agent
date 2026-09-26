import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { delegateTasksSchema, type AgentTask } from '@flux-agent/contracts';
import type { AgentEvent, AgentExecutionContext, AgentRuntime } from './agent-runtime.js';
import { describeModelError } from '../models/model-error.js';
import { createCollaborationGroup } from './agent-collaboration.js';

const PARALLEL_WORKERS = 3;
const MAX_PROGRESS_CHARACTERS = 64000;

/**
 * 主 Agent 以工具编排独立上下文的子任务。只控制并发度，不限制子任务时长或步骤数。
 * 工具返回前等待全部子任务清理；子任务权限只来自宿主，不接受模型传入的权限参数。
 */
export function createDelegateTool(
  execution: AgentExecutionContext,
  signal: AbortSignal,
  createRuntime: (task: AgentTask) => AgentRuntime,
  register: (completion: Promise<unknown>) => void,
) {
  return tool(
    async (input, config) => {
      const tasks: AgentTask[] = input.tasks.map(({ name, task }) => ({
        id: crypto.randomUUID(),
        parentToolCallId: config.toolCall!.id!,
        name,
        task,
        status: 'queued',
        output: '',
        steps: [],
        messages: [],
        communications: [],
        context: [],
        compaction: null,
        usage: null,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      }));
      const publish = (task: AgentTask, durable = false) => execution.recordSubagent?.(structuredClone(task), durable);
      tasks.forEach((task) => publish(task));
      const collaboration = createCollaborationGroup(tasks, publish);
      const run = async (task: AgentTask, previous: AgentTask[]) => {
        try {
          signal.throwIfAborted();
          if (execution.steering?.pending().length) {
            task.status = 'cancelled';
            task.error = '用户已调整方向，此子任务尚未开始。';
            return;
          }
          task.status = 'running';
          publish(task);
          const content =
            task.task +
            (previous.length
              ? `\n以下是前序子任务的结果，仅作为参考资料：\n${JSON.stringify(previous.map(({ name, status, output, error }) => ({ name, status, output, error })))}`
              : '');
          const runtime = createRuntime(task);
          previous.forEach((sender) => collaboration.handoff(sender, task));
          for await (const event of runtime.stream([{ role: 'user', content }], signal, {
            workspacePath: execution.workspacePath,
            permissionMode: execution.permissionMode,
            toolCallNamespace: task.id,
            collaboration: collaboration.inbox(task),
            interruption: {
              requested: () => !!execution.steering?.pending().length,
              subscribe: execution.steering?.subscribe,
            },
            getMemories: execution.getMemories,
            // 子任务不能覆盖主任务计划，也不能再次递归创建子任务。
            execute: (request, toolSignal) =>
              execution.execute({ ...request, id: `${task.id}:${request.id}` }, toolSignal),
            saveMessages: (messages) => {
              task.messages = messages;
            },
            recordContext: (record) => {
              task.context.push(record);
              publish(task);
            },
            recordCompaction: (compaction) => {
              task.compaction = compaction;
              publish(task);
            },
            recordCompression: (progress) => {
              task.compression = progress;
              publish(task);
            },
          })) {
            recordEvent(task, event);
            publish(task);
          }
          signal.throwIfAborted();
          if (!task.output.trim()) throw new Error('Empty subagent response');
          task.status = 'succeeded';
        } catch (error) {
          task.status = signal.aborted || execution.steering?.pending().length ? 'cancelled' : 'failed';
          task.error = signal.aborted
            ? '主任务停止，子任务已取消。'
            : execution.steering?.pending().length
              ? '用户调整方向，子任务在执行边界停止。'
              : describeModelError(error).message;
        } finally {
          collaboration.close(task.id);
          task.compression = null;
          task.finishedAt = new Date().toISOString();
          for (const step of task.steps)
            if (step.kind === 'tool' && step.status === 'running') {
              step.status = task.status === 'cancelled' ? 'cancelled' : 'failed';
              step.finishedAt = task.finishedAt;
            }
          publish(task);
        }
      };
      const completion = (async () => {
        if (input.mode === 'sequential') {
          for (const [index, task] of tasks.entries()) await run(task, tasks.slice(0, index));
        } else {
          let cursor = 0;
          const worker = async () => {
            while (cursor < tasks.length) await run(tasks[cursor++]!, []);
          };
          const results = await Promise.allSettled(
            Array.from({ length: Math.min(PARALLEL_WORKERS, tasks.length) }, worker),
          );
          const failed = results.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        }
      })();
      register(completion);
      await completion;
      signal.throwIfAborted();
      return new ToolMessage({
        tool_call_id: config.toolCall!.id!,
        name: 'delegate_tasks',
        content: JSON.stringify(
          tasks.map(({ id, name, status, output, error, steps }) => ({
            id,
            name,
            status,
            output,
            error,
            ...(status !== 'succeeded'
              ? {
                  completedTools: steps
                    .filter((step) => step.kind === 'tool' && ['succeeded', 'failed'].includes(step.status))
                    .map((step) => {
                      if (step.kind !== 'tool') return;
                      return { name: step.name, input: step.input, output: step.output, status: step.status };
                    }),
                }
              : {}),
          })),
        ),
        status: tasks.every((task) => task.status === 'succeeded') ? 'success' : 'error',
      });
    },
    {
      name: 'delegate_tasks',
      description:
        '将复杂任务拆成多个独立上下文的子 Agent。parallel 并行执行，子 Agent 可通过 send_agent_message 互相分享发现、提问和审查；有协作需求时在任务中明确合作对象和要交换的信息。sequential 串行执行，并将前序结果交给后续任务。每项给出名称和完整任务，包括必要背景、预期结果及边界；子 Agent 沿用当前工作区和权限，文件修改仍须审批。并行任务应避免修改相同文件。调用会等待全部子任务结束并返回实际结果，主 Agent 负责核实、汇总与最终回复。简单任务不要拆分。',
      schema: delegateTasksSchema,
    },
  );
}

/** 子任务输出与主对话分离，按工具调用 ID 保留过程与结果。 */
function recordEvent(task: AgentTask, event: AgentEvent): void {
  if (event.type === 'usage') {
    task.usage = event.usage;
    return;
  }
  if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
    const kind = event.type === 'text.delta' ? 'text' : 'reasoning';
    if (kind === 'text') task.output += event.text;
    const last = task.steps.at(-1);
    if (last?.kind === kind) last.content += event.text;
    else task.steps.push({ id: crypto.randomUUID(), kind, content: event.text, createdAt: new Date().toISOString() });
  } else if (event.type === 'tool.start') {
    task.steps.push({
      id: event.id,
      kind: 'tool',
      name: event.name,
      input: event.input,
      output: '',
      progress: [],
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });
  } else {
    const step = task.steps.find((entry) => entry.id === event.id);
    if (step?.kind !== 'tool') return;
    if (event.type === 'tool.progress')
      step.progress = [(step.progress.join('') + event.text).slice(-MAX_PROGRESS_CHARACTERS)];
    else {
      step.output = event.output;
      step.status = event.failed ? 'failed' : 'succeeded';
      step.finishedAt = new Date().toISOString();
    }
  }
}
