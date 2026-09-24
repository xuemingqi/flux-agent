import type { Run, Thread, Workspace, ModelMessage } from '@flux-agent/contracts';
import { InMemoryMemoryStore } from '../memory/in-memory-memory-store.js';
import type { RunStore, ToolExecution } from './run-store.js';

/**
 * 测试使用的非持久化适配器；生产入口使用 SQLite。
 */
export class InMemoryRunStore implements RunStore {
  readonly memory = new InMemoryMemoryStore();
  private readonly modelHistories = new Map<string, ModelMessage[]>();

  getModelHistory(runId: string): ModelMessage[] | undefined {
    return this.modelHistories.get(runId);
  }

  saveModelHistory(runId: string, messages: ModelMessage[]): void {
    this.modelHistories.set(runId, structuredClone(messages));
  }
  readonly kind = 'memory' as const;

  readonly threads = new Map<string, Thread>();

  readonly runs = new Map<string, Run>();

  readonly workspaces = new Map<string, Workspace>();

  private readonly executions = new Map<string, ToolExecution>();

  saveThread(thread: Thread): void {
    this.threads.set(thread.id, thread);
  }

  deleteThread(id: string): void {
    const thread = this.threads.get(id)!;
    for (const memory of this.memory.list(thread.workspaceId, '', false, ''))
      if (memory.sourceThreadId === id)
        this.memory.update({ ...memory, sourceThreadId: null, sourceRunId: null }, memory.version);
    for (const run of thread.runs) {
      this.runs.delete(run.id);
      this.modelHistories.delete(run.id);
      for (const [key, execution] of this.executions) if (execution.runId === run.id) this.executions.delete(key);
    }
    this.threads.delete(id);
  }

  saveRun(thread: Thread, run: Run): void {
    this.threads.set(thread.id, thread);
    this.runs.set(run.id, run);
  }

  saveWorkspace(workspace: Workspace): void {
    this.workspaces.set(workspace.id, workspace);
  }

  archiveWorkspace(workspace: Workspace): void {
    for (const memory of this.memory.list(workspace.id, '', false, '')) {
      if (memory.sourceThreadId || memory.sourceRunId)
        this.memory.update({ ...memory, sourceThreadId: null, sourceRunId: null }, memory.version);
    }
    for (const run of this.runs.values()) {
      if (run.workspaceId !== workspace.id) continue;
      this.modelHistories.delete(run.id);
      for (const [key, execution] of this.executions) if (execution.runId === run.id) this.executions.delete(key);
      this.runs.delete(run.id);
    }
    for (const thread of this.threads.values()) if (thread.workspaceId === workspace.id) this.threads.delete(thread.id);
    this.workspaces.set(workspace.id, workspace);
  }

  getExecution(runId: string, toolCallId: string): ToolExecution | undefined {
    return this.executions.get(`${runId}:${toolCallId}`);
  }

  saveExecution(execution: ToolExecution): void {
    this.executions.set(`${execution.runId}:${execution.toolCallId}`, { ...execution });
  }
}
