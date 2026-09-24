import { z } from 'zod';
import { updatePlanSchema, type Run, type Workspace, type UpdatePlan, type RunPlan } from '@flux-agent/contracts';
import type { AgentExecutionContext, ToolRequest, ToolResult } from '@flux-agent/agent-runtime';
import type { RunStore, ToolExecution } from '../runs/run-store.js';
import type { ApprovalService } from '../permissions/approval-service.js';
import { ApplicationError } from '../api/application-error.js';
import { contentHash, WorkspaceFiles } from './workspace-files.js';
import { runCommand } from './command-runner.js';
import type { MemoryService } from '../memory/memory-service.js';

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes('\0'));
const toolInputSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('update_plan'), input: updatePlanSchema }),
  z.object({
    name: z.literal('search_memories'),
    input: z
      .object({ query: z.string().trim().max(500), offset: z.number().int().min(0).max(200).default(0) })
      .strict(),
  }),
  z.object({
    name: z.literal('propose_memory'),
    input: z.object({ content: z.string().trim().min(1).max(4000) }).strict(),
  }),
  z.object({ name: z.literal('list_directory'), input: z.object({ path: pathSchema }).strict() }),
  z.object({ name: z.literal('read_file'), input: z.object({ path: pathSchema }).strict() }),
  z.object({
    name: z.literal('search_files'),
    input: z.object({ path: pathSchema, query: z.string().min(1).max(500) }).strict(),
  }),
  z.object({
    name: z.literal('write_file'),
    input: z.object({ path: pathSchema, content: z.string().max(64_000) }).strict(),
  }),
  z.object({
    name: z.literal('run_command'),
    input: z.object({ command: z.string().trim().min(1).max(8000), cwd: pathSchema.optional() }).strict(),
  }),
]);

export class ToolExecutionService {
  private readonly activeCalls = new Set<string>();
  constructor(
    private readonly store: RunStore,
    private readonly approvals: ApprovalService,
    private readonly protectedDirectory?: string,
    private readonly memory?: MemoryService,
    private readonly updatePlan?: (run: Run, input: UpdatePlan) => RunPlan,
  ) {}

  context(run: Run, workspace: Workspace): AgentExecutionContext {
    return {
      workspacePath: workspace.rootPath,
      permissionMode: run.permissionMode,
      ...(this.updatePlan ? { getPlan: () => structuredClone(run.plan) } : {}),
      execute: (request, signal) => this.execute(run, workspace, request, signal),
    };
  }

  /**
   * 权限检查不依赖模型可见的工具清单；直接调用宿主入口也必须通过相同校验。
   */
  private async *execute(
    run: Run,
    workspace: Workspace,
    request: ToolRequest,
    signal: AbortSignal,
  ): AsyncGenerator<string, ToolResult> {
    let receipt: ToolExecution | undefined;
    const key = `${run.id}:${request.id}`;
    if (this.activeCalls.has(key)) return { content: 'DUPLICATE_TOOL_CALL: 该调用正在执行或等待审批。', failed: true };
    this.activeCalls.add(key);
    try {
      signal.throwIfAborted();
      const parsed = toolInputSchema.safeParse(request);
      if (!parsed.success) throw new ApplicationError('INVALID_TOOL_INPUT', '工具参数格式不正确。');
      const call = parsed.data;
      const digest = contentHash(JSON.stringify(call.input));
      const previous = this.store.getExecution(run.id, request.id);
      if (previous)
        throw new ApplicationError('DUPLICATE_TOOL_CALL', '该调用已登记，不能重复执行；请检查原调用结果。', 409);
      receipt = {
        runId: run.id,
        toolCallId: request.id,
        name: request.name,
        inputHash: digest,
        status: 'started',
        result: null,
      };
      if (call.name === 'update_plan') {
        if (!this.updatePlan) throw new ApplicationError('PLAN_UNAVAILABLE', '当前运行未配置任务计划。');
        this.store.saveExecution(receipt);
        const result = JSON.stringify(this.updatePlan(run, call.input));
        this.store.saveExecution({ ...receipt, status: 'succeeded', result });
        return { content: result, failed: false };
      }
      if (call.name === 'propose_memory' || call.name === 'search_memories') {
        if (!this.memory) throw new ApplicationError('MEMORY_UNAVAILABLE', '当前运行未配置记忆服务。');
        this.store.saveExecution(receipt);
        let result: string;
        if (call.name === 'search_memories') {
          yield '正在查询当前工作区已确认的长期记忆';
          signal.throwIfAborted();
          result = JSON.stringify(this.memory.search(run.workspaceId, call.input.query, call.input.offset));
        } else {
          const memory = this.memory.propose(run, call.input.content);
          result = JSON.stringify({
            id: memory.id,
            status: memory.state,
            message: '已提出记忆候选，请到长期记忆页面确认；确认前不会用于其他对话。',
          });
        }
        this.store.saveExecution({ ...receipt, status: 'succeeded', result });
        return { content: result, failed: false };
      }
      if (request.name === 'write_file' && run.permissionMode === 'read-only')
        throw new ApplicationError('WRITE_DENIED', '仅可查看模式不允许修改文件。', 403);
      if (request.name === 'run_command' && run.permissionMode !== 'full-access')
        throw new ApplicationError('COMMAND_DENIED', '本机命令只在用户明确选择完全权限后开放。', 403);
      const files = new WorkspaceFiles(workspace.rootPath, run.permissionMode, this.protectedDirectory);
      let prepared: { path: string; before: string | null; content: string; inputPath: string } | undefined;
      if (call.name === 'write_file') {
        const input = call.input;
        if (Buffer.byteLength(input.content) > 64_000)
          throw new ApplicationError('FILE_LIMIT', '单次写入不能超过 64 KB。');
        const path = files.path(input.path, true);
        const before = files.snapshot(path);
        prepared = { path, before, content: input.content, inputPath: input.path };
        if (run.permissionMode === 'workspace-write') {
          yield '等待用户确认文件修改';
          const approved = await this.approvals.request(
            run,
            { toolCallId: request.id, inputHash: digest, path, before, after: input.content },
            signal,
          );
          signal.throwIfAborted();
          if (!approved) throw new ApplicationError('APPROVAL_DENIED', '本次修改未获批准，未执行写入。');
        }
      }
      signal.throwIfAborted();
      // 在任何实际操作之前写入凭证；同一调用 ID 不会在崩溃后自动重放。
      this.store.saveExecution(receipt);
      let result: ToolResult;
      if (prepared) {
        yield '正在校验原文并写入文件';
        signal.throwIfAborted();
        files.write(prepared.inputPath, prepared.path, prepared.before, prepared.content);
        result = {
          content: JSON.stringify({
            path: prepared.path,
            bytes: Buffer.byteLength(prepared.content),
            status: 'written',
          }),
          failed: false,
        };
      } else if (call.name === 'run_command') {
        yield '正在本机执行命令';
        result = yield* runCommand(call.input.command, files.path(call.input.cwd ?? '.'), signal);
      } else {
        const path = files.path(call.input.path);
        yield '正在读取工作区';
        signal.throwIfAborted();
        const content =
          call.name === 'search_files'
            ? files.search(path, call.input.query)
            : call.name === 'list_directory'
              ? files.list(path)
              : files.read(path);
        result = { content, failed: false };
      }
      this.store.saveExecution({ ...receipt, status: result.failed ? 'failed' : 'succeeded', result: result.content });
      return result;
    } catch (error) {
      const result = {
        content:
          error instanceof ApplicationError
            ? `${error.code}: ${error.message}`
            : signal.aborted
              ? '工具执行已停止；已开始的操作请检查实际状态。'
              : '工具执行失败，请检查路径、文件类型或系统权限。',
        failed: true,
      };
      if (receipt)
        this.store.saveExecution({
          ...receipt,
          status: signal.aborted ? 'interrupted' : 'failed',
          result: result.content,
        });
      signal.throwIfAborted();
      return result;
    } finally {
      this.activeCalls.delete(key);
    }
  }
}
