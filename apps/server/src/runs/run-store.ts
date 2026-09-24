import type { Run, Thread, Workspace, ModelMessage } from '@flux-agent/contracts';
import type { MemoryStore } from '../memory/memory-store.js';

export interface ToolExecution {
  /**
   * 调用在一轮运行中的稳定标识，不能用于自动重放副作用。
   */
  runId: string;
  toolCallId: string;
  name: string;
  inputHash: string;
  status: 'started' | 'succeeded' | 'failed' | 'interrupted';
  result: string | null;
}

/**
 * 运行管理器拥有进程内对象；存储实现负责原子快照和副作用执行凭证。
 */
export interface RunStore {
  readonly memory: MemoryStore;
  readonly kind: 'memory' | 'sqlite';
  readonly threads: Map<string, Thread>;
  readonly runs: Map<string, Run>;
  readonly workspaces: Map<string, Workspace>;
  saveThread(thread: Thread): void;
  /** 删除会话及其运行数据，保留文件和长期记忆并清除记忆来源链接。 */
  deleteThread(id: string): void;
  saveRun(thread: Thread, run: Run): void;
  saveWorkspace(workspace: Workspace): void;
  /**
   * 原子保存移除标记并删除该工作区会话及关联运行数据，保留目录和长期记忆。
   */
  archiveWorkspace(workspace: Workspace): void;
  getExecution(runId: string, toolCallId: string): ToolExecution | undefined;
  saveExecution(execution: ToolExecution): void;
  getModelHistory(runId: string): ModelMessage[] | undefined;
  saveModelHistory(runId: string, messages: ModelMessage[]): void;
}
