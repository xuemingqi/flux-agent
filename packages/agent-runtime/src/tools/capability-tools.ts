import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { capabilityToolSchema } from '@flux-agent/contracts';
import type { AgentExecutionContext } from '../agents/agent-runtime.js';

const descriptions: Record<string, string> = {
  list_skills: '列出所有 Skill、启用状态及版本。',
  read_skill: '加载启用的 SKILL.md 或 Skill 内的文本资源。匹配 Skill 时先加载正文，再执行任务。',
  get_skill: '读取 Skill 完整管理配置、版本和 Base64 资源，供编辑使用；禁用的 Skill 不能用于执行任务。',
  create_skill:
    '创建 Skill。markdown 为完整 SKILL.md，含 YAML name、description 及正文；files 为可选 Base64 资源文件。',
  update_skill:
    '修改 Skill 正文、资源或启用状态。先 get_skill 读取当前版本，名称保持一致；省略 files 保留资源，空数组清除。',
  delete_skill: '按名称及当前版本删除 Skill。',
  import_skill: '导入 Base64 编码的 ZIP 包或 SKILL.md，保留原始资源，同名拒绝覆盖。',
  export_skill: '导出 Skill 为 ZIP（filename 和 Base64 content），保留原始正文和资源。',
  list_mcp_servers: '列出 MCP 配置与版本，只返回凭据键名。',
  create_mcp_server: '创建 MCP 配置。stdio 填 command/args，可选 cwd/env；http 或 sse 填 url 和可选 headers。',
  update_mcp_server: '按当前版本修改 MCP 完整配置或启用状态；省略 env/headers 保留凭据，空对象清除。',
  delete_mcp_server: '按名称及当前版本删除 MCP 配置。',
  list_mcp_tools: '连接启用的 MCP，列出工具及输入 JSON Schema。本地 stdio 需要完全权限。',
  call_mcp_tool: '调用已发现的 MCP 工具，arguments 必须遵循工具的 JSON Schema。工作区模式需逐次审批。',
};
const readActions = new Set([
  'list_skills',
  'get_skill',
  'read_skill',
  'export_skill',
  'list_mcp_servers',
  'list_mcp_tools',
]);

/** 展示轨迹只记录凭据键名，原始参数仍交给宿主执行入口。 */
export function capabilityDisplayInput(name: string, value: unknown): unknown {
  if (!['create_mcp_server', 'update_mcp_server'].includes(name)) return value;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return 'MCP 配置参数（无法解析，已隐藏）';
    }
  }
  if (!parsed || typeof parsed !== 'object') return parsed;
  const input = parsed as Record<string, unknown>;
  return {
    ...input,
    ...('env' in input ? { env: Object.keys((input.env as object) ?? {}) } : {}),
    ...('headers' in input ? { headers: Object.keys((input.headers as object) ?? {}) } : {}),
  };
}

export function createCapabilityTools(execution: AgentExecutionContext, signal: AbortSignal) {
  return capabilityToolSchema.options
    .filter((entry) => execution.permissionMode !== 'read-only' || readActions.has(entry.shape.name.value))
    .map((entry) => {
      const name = entry.shape.name.value;
      return tool(
        async function* (input, config) {
          const id = config.toolCall?.id;
          if (!id) throw new Error('Missing tool call ID');
          const result = yield* execution.execute({ id, name, input }, signal);
          return new ToolMessage({
            tool_call_id: id,
            name,
            content: result.content,
            status: result.failed ? 'error' : 'success',
          });
        },
        { name, description: descriptions[name]!, schema: z.toJSONSchema(entry.shape.input, { io: 'input' }) },
      );
    });
}
