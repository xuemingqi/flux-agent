import type { Approval, RunStep } from '@flux-agent/contracts';

export type ToolStep = Extract<RunStep, { kind: 'tool' }>;

/** 一次工具调用的展示标识包含运行或子任务 ID，避免不同 Agent 的调用 ID 重名。 */
export interface ToolInspection {
  id: string;
  step: ToolStep;
  approval?: Approval;
}

const presentations: Record<string, { label: string; icon: string }> = {
  read_file: { label: '读取', icon: 'file' },
  write_file: { label: '写入', icon: 'edit' },
  list_directory: { label: '目录', icon: 'folder' },
  search_files: { label: '搜索', icon: 'search' },
  run_command: { label: 'Bash', icon: 'terminal' },
  update_plan: { label: '计划', icon: 'trace' },
  search_memories: { label: '检索记忆', icon: 'memory' },
  propose_memory: { label: '记忆提议', icon: 'memory' },
  delegate_tasks: { label: '子 Agent', icon: 'agents' },
  get_current_time: { label: '时间', icon: 'clock' },
};

export function toolPresentation(name: string) {
  return presentations[name] ?? { label: name, icon: 'code' };
}

export function parseToolObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    // 文件内容和工具异常可以是纯文本，不能当作结构化结果使用。
    return {};
  }
}

export function toolTarget(step: ToolStep): string {
  const { command, path, query, tasks, timeZone, explanation, content } = parseToolObject(step.input);
  if (typeof command === 'string') return command;
  if (typeof path === 'string') return typeof query === 'string' ? `${path} · ${query}` : path;
  if (typeof query === 'string') return query || '浏览工作区记忆';
  if (Array.isArray(tasks))
    return tasks
      .map((task) => task?.name)
      .filter(Boolean)
      .join('、');
  if (typeof timeZone === 'string') return timeZone;
  if (typeof explanation === 'string') return explanation;
  if (typeof content === 'string') return content.replace(/\s+/g, ' ');
  const result = parseToolObject(step.output);
  return typeof result.localTime === 'string' ? result.localTime : '';
}

export function toolStatus(step: ToolStep): string {
  if (step.status === 'succeeded') {
    if (step.name === 'read_file') return '读取成功';
    if (step.name === 'write_file') return '写入成功';
  }
  return {
    running: '执行中',
    succeeded: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
    interrupted: '已中断，需检查',
  }[step.status];
}
