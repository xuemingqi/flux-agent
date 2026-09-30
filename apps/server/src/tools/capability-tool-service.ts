import type { CapabilityToolCall, PermissionMode, Run } from '@flux-agent/contracts';
import type { ToolRequest, ToolResult } from '@flux-agent/agent-runtime';
import type { SkillService } from '../skills/skill-service.js';
import { publicMcp, type McpService } from '../mcp/mcp-service.js';
import type { ApprovalService } from '../permissions/approval-service.js';
import { ApplicationError } from '../api/application-error.js';

const READ_ACTIONS = new Set([
  'list_skills',
  'get_skill',
  'read_skill',
  'export_skill',
  'list_mcp_servers',
  'list_mcp_tools',
]);

/** Tool 应用层：处理 Agent 权限、审批及并发快照，然后调用共享基础能力。 */
export class CapabilityToolService {
  constructor(
    private readonly skills: SkillService,
    private readonly mcps: McpService,
    private readonly approvals: ApprovalService,
  ) {}

  catalog() {
    return {
      skills: this.skills
        .list()
        .filter((entry) => entry.enabled)
        .map(({ name, description }) => ({ name, description })),
      mcps: this.mcps
        .list()
        .filter((entry) => entry.enabled)
        .map(({ name, transport }) => ({ name, transport })),
    };
  }

  async *execute(
    run: Run,
    request: ToolRequest,
    call: CapabilityToolCall,
    digest: string,
    signal: AbortSignal,
  ): AsyncGenerator<string, ToolResult> {
    this.checkPermission(run.permissionMode, call);
    const mcpVersion =
      call.name === 'list_mcp_tools' || call.name === 'call_mcp_tool'
        ? this.mcps.get(call.input.name).version
        : undefined;
    // 导入在审批前完成归档校验；审批展示技能正文和资源清单，不展示二进制包。
    const imported =
      call.name === 'import_skill' ? this.skills.prepareImport(call.input.filename, call.input.content) : null;
    const resourceName = imported?.name ?? ('name' in call.input ? call.input.name : '');
    const before = this.snapshot(call, resourceName);
    const approvalRequired = !READ_ACTIONS.has(call.name) && run.permissionMode === 'workspace-write';
    if (approvalRequired) {
      yield '等待用户确认能力操作';
      const approved = await this.approvals.request(
        run,
        {
          toolCallId: request.id,
          inputHash: digest,
          kind: call.name === 'call_mcp_tool' ? 'mcp' : 'capability',
          path: `${call.name}: ${resourceName}`,
          before,
          after: JSON.stringify(
            imported ? { ...imported, files: imported.files.map(({ path }) => ({ path })) } : this.redact(call.input),
            null,
            2,
          ),
        },
        signal,
      );
      signal.throwIfAborted();
      if (!approved) throw new ApplicationError('APPROVAL_DENIED', '本次能力操作未获批准。', 403);
      if (this.snapshot(call, resourceName) !== before)
        throw new ApplicationError('CAPABILITY_CONFLICT', '审批期间资源已变化，请重新发起操作。', 409);
    }
    signal.throwIfAborted();
    yield call.name.includes('mcp') ? '正在处理 MCP 操作' : '正在处理 Skill 操作';
    let result: unknown;
    switch (call.name) {
      case 'list_skills':
        result = this.skills.list();
        break;
      case 'read_skill':
        result = this.skills.read(call.input.name, call.input.path);
        break;
      case 'get_skill':
        return { content: JSON.stringify(this.skills.get(call.input.name)), failed: false };
      case 'create_skill':
        result = this.skills.create(call.input);
        break;
      case 'update_skill':
        result = this.skills.update(call.input.name, call.input);
        break;
      case 'delete_skill':
        this.skills.delete(call.input.name, call.input.version);
        result = { deleted: true };
        break;
      case 'import_skill':
        result = this.skills.create(imported!);
        break;
      case 'export_skill':
        result = this.skills.export(call.input.name);
        break;
      case 'list_mcp_servers':
        result = this.mcps.list();
        break;
      case 'create_mcp_server':
        result = publicMcp(this.mcps.create(call.input));
        break;
      case 'update_mcp_server':
        result = publicMcp(this.mcps.update(call.input.name, call.input));
        break;
      case 'delete_mcp_server':
        this.mcps.delete(call.input.name, call.input.version);
        result = { deleted: true };
        break;
      case 'list_mcp_tools':
        result = await this.mcps.listTools(call.input.name, signal, mcpVersion);
        break;
      case 'call_mcp_tool':
        return await this.mcps.callTool(call.input.name, call.input.tool, call.input.arguments, signal, mcpVersion);
    }
    if (result && typeof result === 'object' && 'markdown' in result) {
      const { files, markdown: _markdown, ...entry } = result as ReturnType<SkillService['get']>;
      result = { ...entry, files: files.map(({ path }) => path) };
    }
    return { content: JSON.stringify(result), failed: false };
  }

  /** MCP 声明的只读提示不是权限证明；外部调用在工作区模式下一律逐次审批。 */
  private checkPermission(mode: PermissionMode, call: CapabilityToolCall): void {
    if (!READ_ACTIONS.has(call.name) && mode === 'read-only')
      throw new ApplicationError('CAPABILITY_WRITE_DENIED', '仅可查看模式不允许管理能力或调用外部 MCP 工具。', 403);
    if (
      (call.name === 'call_mcp_tool' || call.name === 'list_mcp_tools') &&
      this.mcps.get(call.input.name).transport === 'stdio' &&
      mode !== 'full-access'
    )
      throw new ApplicationError('MCP_PROCESS_DENIED', '启动本地 MCP 进程需要完全权限。', 403);
  }

  /** 审批仅携带脱敏配置或文本清单，实际写入仍使用原始已校验参数。 */
  private redact(input: CapabilityToolCall['input']) {
    if ('env' in input || 'headers' in input)
      return {
        ...input,
        ...('env' in input ? { env: Object.keys(input.env ?? {}) } : {}),
        ...('headers' in input ? { headers: Object.keys(input.headers ?? {}) } : {}),
      };
    if ('files' in input) return { ...input, files: input.files?.map(({ path }) => ({ path })) };
    return input;
  }

  /** 捕获版本而非连接对象，避免等待审批时持有进程和网络连接。 */
  private snapshot(call: CapabilityToolCall, name: string): string | null {
    if (!name || READ_ACTIONS.has(call.name)) return null;
    if (call.name.includes('mcp')) return JSON.stringify(this.mcps.list().find((entry) => entry.name === name) ?? null);
    return JSON.stringify(this.skills.list().find((entry) => entry.name === name) ?? null);
  }
}
