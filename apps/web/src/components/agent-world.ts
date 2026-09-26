import type { AgentTask, AgentCommunication, Approval, Run, RunStep } from '@flux-agent/contracts';
import { toolPresentation, toolTarget, type ToolInspection, type ToolStep } from './tool-presentation';

export type AgentActivity =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'speaking'
  | 'reading'
  | 'writing'
  | 'command'
  | 'delegating'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface WorldAgent {
  id: string;
  name: string;
  task: string;
  role: string;
  steps: RunStep[];
  activity: AgentActivity;
  label: string;
  bubble: string;
  bubbleKind: string;
  history: WorldHistoryRound[];
}

export interface WorldHistoryRound {
  id: string;
  agentId: string;
  label: string;
  task: string;
  entries: (
    | { id: string; createdAt: string; kind: 'message'; label: string; content: string }
    | { id: string; createdAt: string; kind: 'tool'; step: ToolStep }
  )[];
}

type Activity = Pick<WorldAgent, 'activity' | 'label' | 'bubble' | 'bubbleKind'>;

/** 展示仅投影已收到的任务事实，不创建任务、推测思考或编造 Agent 间通信。 */
function activity(source: Run | AgentTask, approvals: Approval[]): Activity {
  const state = (activity: AgentActivity, label: string, bubble: string, bubbleKind = '执行状态'): Activity => ({
    activity,
    label,
    bubble,
    bubbleKind,
  });
  if (source.status === 'succeeded') return state('done', '已完成', source.output || '任务已完成。', '任务输出');
  if (source.status === 'failed')
    return state(
      'failed',
      '执行失败',
      typeof source.error === 'string' ? source.error : source.error?.message || '任务执行失败。',
    );
  if (source.status === 'cancelled' || source.status === 'interrupted')
    return state('cancelled', source.status === 'cancelled' ? '已停止' : '已中断', '已完成的步骤保留在过程记录中。');
  if (source.status === 'cancelling') return state('waiting', '正在停止', '正在等待已开始的执行单元退出。');
  if (source.status === 'queued') return state('idle', '等待开始', '子任务已创建，等待开始执行。');

  const tool = source.steps.findLast((step): step is ToolStep => step.kind === 'tool' && step.status === 'running');
  if (
    source.status === 'waiting_approval' ||
    (tool && approvals.some((entry) => entry.status === 'pending' && matchesCall(entry, source.id, tool)))
  )
    return state('waiting', '等待审批', '等待你确认文件修改；审批通过后继续执行。');
  if (source.compression)
    return state(
      'thinking',
      '压缩上下文',
      `正在整理上下文：${source.compression.completed}/${source.compression.total} 个片段。`,
    );
  if (tool) {
    const actions: Record<string, AgentActivity> = {
      read_file: 'reading',
      list_directory: 'reading',
      search_files: 'reading',
      search_memories: 'reading',
      write_file: 'writing',
      run_command: 'command',
      delegate_tasks: 'delegating',
      send_agent_message: 'speaking',
      receive_agent_messages: 'waiting',
    };
    const label = tool.name === 'delegate_tasks' ? '等待子 Agent' : `正在${toolPresentation(tool.name).label}`;
    const target = toolTarget(tool);
    return state(actions[tool.name] ?? 'working', label, tool.progress.at(-1) || target || label, '工具活动');
  }
  const last = source.steps.at(-1);
  if (last?.kind === 'reasoning') return state('thinking', '正在思考', last.content, '模型返回的思考');
  if (last?.kind === 'text') return state('speaking', '正在输出', last.content, '模型输出');
  return state('idle', source.steps.length ? '等待模型响应' : '正在连接模型', '等待新的模型输出。');
}

export interface WorldCommunication extends AgentCommunication {
  fromName: string;
  toName: string;
}
export function worldCommunications(tasks: AgentTask[]): WorldCommunication[] {
  const names = new Map(tasks.map((task) => [task.id, task.name]));
  return tasks
    .flatMap((task) => task.communications ?? [])
    .map((message) => ({
      ...message,
      fromName: names.get(message.fromAgentId) ?? '历史 Agent',
      toName: names.get(message.toAgentId) ?? '历史 Agent',
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function historyRound(run: Run, source: Run | AgentTask, task: string, label: string): WorldHistoryRound {
  const entries: WorldHistoryRound['entries'] = source.steps.map((step) =>
    step.kind === 'tool'
      ? { id: step.id, createdAt: step.createdAt, kind: 'tool', step }
      : {
          id: step.id,
          createdAt: step.createdAt,
          kind: 'message',
          label: { text: '模型输出', reasoning: '模型返回的思考', steering: '补充指令' }[step.kind],
          content: step.content,
        },
  );
  for (const message of worldCommunications(run.subagents)) {
    if (message.fromAgentId !== source.id && message.toAgentId !== source.id) continue;
    const route = message.fromAgentId === source.id ? `发送给 ${message.toName}` : `来自 ${message.fromName}`;
    const status = { pending: '待接收', delivered: '已送达', not_delivered: '未送达' }[message.status];
    entries.push({
      id: `communication:${message.id}`,
      createdAt: message.createdAt,
      kind: 'message',
      label: `${route} · ${message.kind === 'handoff' ? '结果交接 · ' : ''}${status}`,
      content: message.content,
    });
  }
  // 旧记录可能只有 output；有文本步骤时不再重复显示汇总的 output。
  if (source.output && !source.steps.some((step) => step.kind === 'text'))
    entries.push({
      id: 'output',
      createdAt: source.finishedAt ?? source.createdAt,
      kind: 'message',
      label: '任务输出',
      content: source.output,
    });
  if (source.error)
    entries.push({
      id: 'error',
      createdAt: source.finishedAt ?? source.createdAt,
      kind: 'message',
      label: '执行错误',
      content: typeof source.error === 'string' ? source.error : source.error.message,
    });
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { id: run.id, agentId: source.id, label, task, entries };
}

export function worldAgents(
  run: Run,
  question: string,
  turns: { run: Run; question: string }[] = [{ run, question }],
): WorldAgent[] {
  const index = turns.findIndex((turn) => turn.run.id === run.id);
  const history = turns
    .slice(0, index + 1)
    .map((turn, round) => historyRound(turn.run, turn.run, turn.question, `第 ${round + 1} 轮`));
  return [
    {
      id: run.id,
      name: '主 Agent',
      task: question,
      role: '协调与汇总',
      steps: run.steps,
      history,
      ...activity(run, run.approvals),
    },
    ...run.subagents.map((task) => ({
      id: task.id,
      name: task.name,
      task: task.task,
      role: '子 Agent',
      steps: task.steps,
      history: [historyRound(run, task, task.task, '任务记录')],
      ...activity(task, run.approvals),
    })),
  ];
}

function matchesCall(approval: Approval, agentId: string, step: ToolStep): boolean {
  return approval.toolCallId === step.id || approval.toolCallId === `${agentId}:${step.id}`;
}

export function inspectWorldTool(run: Run, agentId: string, step: ToolStep): ToolInspection {
  return {
    id: `${agentId}/${step.id}`,
    step,
    approval: run.approvals.find((entry) => matchesCall(entry, agentId, step)),
  };
}

export function inspectWorldApproval(run: Run, approval: Approval): ToolInspection | undefined {
  for (const agent of worldAgents(run, '')) {
    const step = agent.steps.find(
      (entry): entry is ToolStep => entry.kind === 'tool' && matchesCall(approval, agent.id, entry),
    );
    if (step) return inspectWorldTool(run, agent.id, step);
  }
}
