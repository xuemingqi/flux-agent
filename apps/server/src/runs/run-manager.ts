import type { AgentEvent, AgentRuntime, ConversationMessage } from '@flux-agent/agent-runtime';
import { ContextBudgetError, describeModelError } from '@flux-agent/agent-runtime';
import {
  DEFAULT_PERMISSION_MODE,
  isRunActive,
  type ApiError,
  type Run,
  type Thread,
  type ThreadSummary,
  type PermissionMode,
  type UpdatePlan,
  type RunPlan,
  type FeedbackInput,
  type CreateSteering,
  type FilePreview,
} from '@flux-agent/contracts';
import type { Logger } from 'pino';
import { ApplicationError } from '../api/application-error.js';
import type { RunStore } from './run-store.js';
import { WorkspaceService } from '../workspaces/workspace-service.js';
import { ApprovalService } from '../permissions/approval-service.js';
import { ToolExecutionService } from '../tools/tool-execution-service.js';
import { MemoryService } from '../memory/memory-service.js';
import { WorkspaceFiles } from '../tools/workspace-files.js';

const MAX_THREADS = 100;
const MAX_ACTIVE_RUNS = 4;
const MAX_TOOL_PROGRESS_CHARACTERS = 64_000;

export class RunManager {
  private readonly active = new Map<
    string,
    { controller: AbortController; completion: Promise<void>; acceptingSteering: boolean }
  >();

  private readonly listeners = new Map<string, Set<() => void>>();

  readonly workspaces: WorkspaceService;
  readonly approvals: ApprovalService;
  readonly memory: MemoryService;
  private readonly tools: ToolExecutionService;
  private readonly persistedAt = new Map<string, number>();

  constructor(
    private readonly store: RunStore,
    private readonly getRuntime: () => AgentRuntime | null,
    private readonly logger: Logger,
    private readonly protectedDirectory?: string,
  ) {
    this.workspaces = new WorkspaceService(store);
    this.approvals = new ApprovalService((run) => {
      this.persist(run);
      this.notify(run.id);
    });
    this.memory = new MemoryService(store.memory);
    this.tools = new ToolExecutionService(store, this.approvals, protectedDirectory, this.memory, (run, input) =>
      this.updatePlan(run, input),
    );
  }

  get storage(): 'memory' | 'sqlite' {
    return this.store.kind;
  }

  listThreads(): ThreadSummary[] {
    return [...this.store.threads.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ messages: _messages, runs: _runs, ...summary }) => ({ ...summary }));
  }

  createThread(workspaceId?: string): Thread {
    if (this.store.threads.size >= MAX_THREADS) {
      throw new ApplicationError('THREAD_LIMIT', '当前版本最多保存 100 个会话。', 429);
    }
    const now = new Date().toISOString();
    const workspace = this.workspaces.require(
      workspaceId ??
        this.workspaces.list().find((entry) => !entry.archivedAt)?.id ??
        this.workspaces.create(process.cwd()).id,
    );
    if (workspace.archivedAt)
      throw new ApplicationError('WORKSPACE_ARCHIVED', '请先重新添加此工作区，再创建会话。', 409);
    const thread: Thread = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      permissionMode: DEFAULT_PERMISSION_MODE,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      runs: [],
    };
    this.store.saveThread(thread);
    return structuredClone(thread);
  }

  getThread(id: string): Thread {
    return structuredClone(this.requireThread(id));
  }

  /**
   * 用户从工具记录打开文件时只读取磁盘，复用会话权限及密钥目录保护，不创建工具调用或消息。
   */
  previewFile(threadId: string, inputPath: string): FilePreview {
    const thread = this.requireThread(threadId);
    const workspace = this.workspaces.require(thread.workspaceId);
    const files = new WorkspaceFiles(workspace.rootPath, thread.permissionMode, this.protectedDirectory);
    const path = files.path(inputPath);
    return { path, content: files.read(path) };
  }

  renameThread(id: string, title: string): Thread {
    const thread = this.requireThread(id);
    const previous = thread.title;
    thread.title = title;
    try {
      this.store.saveThread(thread);
    } catch (error) {
      thread.title = previous;
      throw error;
    }
    return structuredClone(thread);
  }

  deleteThread(id: string): void {
    const thread = this.requireThread(id);
    if (thread.runs.some((run) => isRunActive(run.status)))
      throw new ApplicationError('RUN_ACTIVE', '请先停止会话中正在运行的任务，再删除会话。', 409);
    this.store.deleteThread(id);
  }

  getRun(id: string): Run {
    return structuredClone(this.requireRun(id));
  }

  /** 用户补充先持久化再确认接收；相同消息 ID 的重试不会多次执行。 */
  steerRun(id: string, input: CreateSteering): Run {
    const run = this.requireRun(id);
    const existing = run.steering.find((entry) => entry.id === input.id);
    if (existing) {
      if (existing.content !== input.content)
        throw new ApplicationError('STEERING_CONFLICT', '消息标识已被使用，请重新发送。', 409);
      return structuredClone(run);
    }
    if ((run.status !== 'running' && run.status !== 'waiting_approval') || !this.active.get(id)?.acceptingSteering)
      throw new ApplicationError('STEERING_CLOSED', '本轮已在结束或不接受补充消息，请稍后重新发送。', 409);
    const previousUpdatedAt = this.requireThread(run.threadId).updatedAt;
    const now = new Date().toISOString();
    run.steering.push({ ...input, status: 'pending', createdAt: now, appliedAt: null });
    this.requireThread(run.threadId).updatedAt = now;
    try {
      this.persist(run);
    } catch (error) {
      run.steering.pop();
      this.requireThread(run.threadId).updatedAt = previousUpdatedAt;
      throw error;
    }
    this.notify(id);
    return structuredClone(run);
  }

  /**
   * 反馈仅由用户接口写入。版本检查避免多个页面互相覆盖，不自动注入提示词或转为记忆。
   */
  saveFeedback(id: string, input: FeedbackInput): Run {
    const run = this.requireRun(id);
    if (isRunActive(run.status)) throw new ApplicationError('RUN_ACTIVE', '本轮结束后再提交反馈。', 409);
    if (input.version !== (run.feedback?.version ?? 0))
      throw new ApplicationError('FEEDBACK_CONFLICT', '反馈已在其他页面修改，请刷新后重试。', 409);
    const previous = run.feedback;
    run.feedback = { ...input, version: input.version + 1, updatedAt: new Date().toISOString() };
    try {
      this.persist(run);
    } catch (error) {
      run.feedback = previous;
      throw error;
    }
    this.notify(id);
    return structuredClone(run);
  }

  /**
   * 权限选择只能来自用户接口，执行中的运行不可提权。
   */
  setPermission(threadId: string, mode: PermissionMode, confirmFullAccess: boolean): Thread {
    const thread = this.requireThread(threadId);
    if (thread.runs.some((run) => isRunActive(run.status)))
      throw new ApplicationError('RUN_ACTIVE', '请先停止当前运行，再修改权限。', 409);
    if (mode === 'full-access' && !confirmFullAccess)
      throw new ApplicationError('CONFIRM_FULL_ACCESS', '完全权限需要明确确认本机文件、命令及网络访问风险。', 409);
    thread.permissionMode = mode;
    this.store.saveThread(thread);
    return structuredClone(thread);
  }

  startRun(threadId: string, content: string): Run {
    const thread = this.requireThread(threadId);
    const runtime = this.getRuntime();
    if (!runtime) throw new ApplicationError('MODEL_NOT_CONFIGURED', '请先在模型设置页面完成配置。', 503);
    if (thread.runs.some((run) => isRunActive(run.status))) {
      throw new ApplicationError('RUN_ACTIVE', '当前对话正在生成，请等待完成或停止后再发送。', 409);
    }
    if (this.active.size >= MAX_ACTIVE_RUNS) throw new ApplicationError('RUN_LIMIT', '同时运行的对话已达上限。', 429);

    // 中断和失败产生的半成品保留展示，但不伪装成已完成的上下文传给模型。
    const messages: ConversationMessage[] = thread.runs
      .filter((run) => run.status === 'succeeded')
      .flatMap(
        (run) =>
          this.store.getModelHistory(run.id) ??
          thread.messages.filter((message) => message.runId === run.id).map(({ role, content }) => ({ role, content })),
      );
    messages.push({ role: 'user', content });
    const now = new Date().toISOString();
    const run: Run = {
      id: crypto.randomUUID(),
      threadId,
      workspaceId: thread.workspaceId,
      permissionMode: thread.permissionMode,
      approvals: [],
      assistantMessageId: crypto.randomUUID(),
      status: 'running',
      output: '',
      steps: [],
      context: [],
      agent: runtime.identity ?? null,
      plan: null,
      feedback: null,
      steering: [],
      compaction: thread.runs.findLast((entry) => entry.status === 'succeeded')?.compaction ?? null,
      subagents: [],
      compression: null,
      createdAt: now,
      finishedAt: null,
      usage: null,
      error: null,
    };
    thread.messages.push(
      { id: crypto.randomUUID(), runId: run.id, role: 'user', content, createdAt: now },
      { id: run.assistantMessageId, runId: run.id, role: 'assistant', content: '', createdAt: now },
    );
    if (thread.runs.length === 0 && thread.title === '新对话') thread.title = content.slice(0, 40);
    thread.updatedAt = now;
    thread.runs.push(run);
    this.store.runs.set(run.id, run);
    this.persist(run);

    const controller = new AbortController();
    // 先登记活动运行，再在微任务启动执行，避免同步失败留下过期锁。
    const completion = Promise.resolve().then(() => this.execute(run, messages, controller, runtime));
    this.active.set(run.id, { controller, completion, acceptingSteering: runtime.supportsSteering === true });
    return structuredClone(run);
  }

  cancelRun(id: string): Run {
    const run = this.requireRun(id);
    if (isRunActive(run.status)) {
      run.status = 'cancelling';
      this.persist(run);
      this.active.get(id)?.controller.abort();
      this.notify(id);
    }
    return structuredClone(run);
  }

  subscribe(id: string, listener: () => void): () => void {
    this.requireRun(id);
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  async shutdown(): Promise<void> {
    const completions = [...this.active.values()].map((run) => run.completion);
    for (const id of this.active.keys()) this.cancelRun(id);
    await Promise.all(completions);
  }

  /**
   * 将模型事件转为业务状态，只有资源清理结束后才发布取消终态。
   */
  private async execute(
    run: Run,
    messages: ConversationMessage[],
    controller: AbortController,
    runtime: AgentRuntime,
  ): Promise<void> {
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      for await (const event of runtime.stream(messages, signal, {
        ...this.tools.context(run, this.workspaces.require(run.workspaceId)),
        getMemories: () =>
          this.memory.retrieve(run.workspaceId, run.steering.at(-1)?.content ?? messages.at(-1)!.content),
        recordContext: (record) => {
          run.context.push(record);
          this.persist(run);
          this.notify(run.id);
        },
        saveMessages: (history) => this.store.saveModelHistory(run.id, history),
        compaction: run.compaction,
        recordCompaction: (compaction) => {
          run.compaction = compaction;
          this.persist(run);
          this.notify(run.id);
        },
        recordCompression: (progress) => {
          run.compression = progress;
          this.persist(run);
          this.notify(run.id);
        },
        recordSubagent: (task) => {
          const index = run.subagents.findIndex((entry) => entry.id === task.id);
          if (index < 0) run.subagents.push(structuredClone(task));
          else run.subagents[index] = structuredClone(task);
          if (task.status !== 'running' || Date.now() - (this.persistedAt.get(run.id) ?? 0) >= 500) this.persist(run);
          this.notify(run.id);
        },
        ...(runtime.supportsSteering
          ? {
              steering: {
                subscribe: (listener: () => void) => {
                  let latestId = run.steering.at(-1)?.id;
                  return this.subscribe(run.id, () => {
                    const nextId = run.steering.at(-1)?.id;
                    if (nextId === latestId) return;
                    latestId = nextId;
                    listener();
                  });
                },
                pending: () => structuredClone(run.steering.filter((entry) => entry.status === 'pending')),
                apply: (ids: string[]) => this.applySteering(run, ids),
                finish: () => {
                  if (run.steering.some((entry) => entry.status === 'pending')) return false;
                  this.active.get(run.id)!.acceptingSteering = false;
                  return true;
                },
              },
            }
          : {}),
      })) {
        signal.throwIfAborted();
        if (event.type === 'text.delta') {
          // 不同模型步骤的说明与最终答复保留段落边界。
          if (run.output && run.steps.at(-1)?.kind !== 'text') run.output += '\n\n';
          run.output += event.text;
          const message = this.requireThread(run.threadId).messages.find(
            (entry) => entry.id === run.assistantMessageId,
          )!;
          message.content = run.output;
        } else if (event.type === 'usage') {
          run.usage = event.usage;
        }
        this.recordStep(run, event);
        // 关键工具事件立即落库；token 快照每 500 ms 合并，避免逐 token 写 SQLite。
        if (
          event.type === 'tool.start' ||
          event.type === 'tool.end' ||
          Date.now() - (this.persistedAt.get(run.id) ?? 0) >= 500
        )
          this.persist(run);
        this.notify(run.id);
      }
      signal.throwIfAborted();
      if (!run.output.trim()) throw new ApplicationError('EMPTY_RESPONSE', '模型未返回文本，请确认模型支持文字对话。');
      run.status = 'succeeded';
    } catch (error) {
      if (run.status === 'cancelling') {
        run.status = 'cancelled';
      } else {
        run.status = 'failed';
        run.error = this.describeError(error);
      }
    } finally {
      controller.abort();
      run.compression = null;
      run.finishedAt = new Date().toISOString();
      for (const entry of run.steering) if (entry.status === 'pending') entry.status = 'not_applied';
      for (const step of run.steps) {
        if (step.kind !== 'tool' || step.status !== 'running') continue;
        step.status = run.status === 'cancelled' ? 'cancelled' : 'failed';
        step.finishedAt = run.finishedAt;
        step.output = run.status === 'cancelled' ? '调用已停止。' : '调用未完成。';
      }
      this.requireThread(run.threadId).updatedAt = run.finishedAt;
      try {
        this.persist(run);
      } catch {
        run.status = 'failed';
        run.error = {
          code: 'STORAGE_ERROR',
          message: '执行状态未能保存，请检查磁盘空间和数据库。已开始的文件或命令操作请检查实际状态。',
        };
      }
      this.persistedAt.delete(run.id);
      this.active.delete(run.id);
      this.notify(run.id);
      // 上游异常可能包含密钥、请求体或网关响应；日志只记录归一化错误码。
      this.logger.info(
        { runId: run.id, threadId: run.threadId, status: run.status, code: run.error?.code },
        'Run finished',
      );
    }
  }

  /**
   * 同类文本增量合并为步骤，工具生命周期按调用 ID 更新，保留真实执行顺序。
   */
  private recordStep(run: Run, event: AgentEvent): void {
    if (event.type === 'usage') return;
    if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
      if (!event.text) return;
      const kind = event.type === 'text.delta' ? 'text' : 'reasoning';
      const previous = run.steps.at(-1);
      if (previous?.kind === kind) previous.content += event.text;
      else run.steps.push({ id: crypto.randomUUID(), kind, content: event.text, createdAt: new Date().toISOString() });
      return;
    }
    if (event.type === 'tool.start') {
      run.steps.push({
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
      return;
    }
    const step = run.steps.find((entry) => entry.id === event.id);
    if (step?.kind !== 'tool') return;
    if (event.type === 'tool.progress') {
      step.progress.push(event.text);
      if (step.progress.reduce((total, text) => total + text.length, 0) > MAX_TOOL_PROGRESS_CHARACTERS)
        step.progress = [
          '…（早期进度已省略，工具仍继续运行）',
          step.progress.join('').slice(-MAX_TOOL_PROGRESS_CHARACTERS),
        ];
    } else {
      step.output = event.output;
      step.status = event.failed ? 'failed' : 'succeeded';
      step.finishedAt = new Date().toISOString();
    }
  }

  /** 只对进入本次模型请求的补充消息落下接收回执，刷新后也能区分未处理消息。 */
  private applySteering(run: Run, ids: string[]): void {
    const pending = run.steering.filter((entry) => entry.status === 'pending' && ids.includes(entry.id));
    if (!pending.length) return;
    const before = run.steps.length;
    const now = new Date().toISOString();
    for (const entry of pending) {
      entry.status = 'applied';
      entry.appliedAt = now;
      run.steps.push({ id: entry.id, kind: 'steering', content: entry.content, createdAt: entry.createdAt });
    }
    try {
      this.persist(run);
    } catch (error) {
      run.steps.splice(before);
      for (const entry of pending) {
        entry.status = 'pending';
        entry.appliedAt = null;
      }
      throw error;
    }
    this.notify(run.id);
  }

  /**
   * 模型只能更新所属运行的计划；版本冲突要求重新读取，结束不会自动勾选未完成步骤。
   */
  private updatePlan(run: Run, input: UpdatePlan): RunPlan {
    if (run.status !== 'running') throw new ApplicationError('PLAN_CLOSED', '当前运行不接受计划更新。', 409);
    if (input.version !== (run.plan?.version ?? 0))
      throw new ApplicationError(
        'PLAN_CONFLICT',
        `计划已变更，当前版本为 ${run.plan?.version ?? 0}，请依据最新计划重试。`,
        409,
      );
    if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
      throw new ApplicationError('INVALID_PLAN', '计划的步骤标识不能重复。');
    if (input.steps.filter((step) => step.status === 'in_progress').length > 1)
      throw new ApplicationError('INVALID_PLAN', '计划最多只能有一个进行中的步骤。');
    const previous = run.plan;
    run.plan = { ...input, version: input.version + 1, updatedAt: new Date().toISOString() };
    try {
      this.persist(run);
    } catch (error) {
      run.plan = previous;
      throw error;
    }
    this.notify(run.id);
    return structuredClone(run.plan);
  }

  /**
   * 对外只暴露稳定错误，避免把供应商响应中的凭据和内部地址传给浏览器。
   */
  private describeError(error: unknown): ApiError {
    if (error instanceof ContextBudgetError) return { code: 'CONTEXT_BUDGET', message: error.message };
    if (error instanceof ApplicationError) return { code: error.code, message: error.message };
    return describeModelError(error);
  }

  /**
   * 对不存在的会话统一返回业务错误。
   */
  private requireThread(id: string): Thread {
    const thread = this.store.threads.get(id);
    if (!thread) throw new ApplicationError('THREAD_NOT_FOUND', '会话不存在。', 404);
    return thread;
  }

  /**
   * 对不存在的运行统一返回业务错误。
   */
  private requireRun(id: string): Run {
    const run = this.store.runs.get(id);
    if (!run) throw new ApplicationError('RUN_NOT_FOUND', '运行不存在。', 404);
    return run;
  }

  /**
   * 只通知状态变化，订阅者自行读取快照，避免为慢连接积压 token 队列。
   */
  private notify(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  /**
   * 状态和关联消息在一个短事务内保存，事务不跨模型或审批等待。
   */
  private persist(run: Run): void {
    this.store.saveRun(this.requireThread(run.threadId), run);
    if (isRunActive(run.status)) this.persistedAt.set(run.id, Date.now());
  }
}
