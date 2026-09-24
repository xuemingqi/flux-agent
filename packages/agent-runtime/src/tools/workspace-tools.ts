import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { AgentExecutionContext } from '../agents/agent-runtime.js';

const definitions = [
  {
    name: 'update_plan',
    description:
      '创建或更新本轮任务计划。多步骤任务先列计划，再随实际进度更新；简单问答无需计划。每次提交完整步骤列表及当前版本（首次 0），最多一项进行中。受阻用 blocked，取消的步骤用 skipped，并说明原因；不能把未执行或失败的操作标成完成。更新计划不会获得额外权限。',
    properties: {
      version: { type: 'integer', minimum: 0, description: '宿主当前计划版本，首次为 0' },
      explanation: { type: 'string', maxLength: 1000, description: '简洁的计划说明或本次变更原因' },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 80, description: '步骤稳定标识，修改状态时沿用' },
            title: { type: 'string', maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] },
          },
          required: ['id', 'title', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['version', 'explanation', 'steps'],
  },
  {
    name: 'search_memories',
    description:
      '查询当前工作区已确认、未过期的长期记忆，跨会话可用，也可在只读模式使用。回答身份、称呼、偏好或约定时，已提供的记忆不足就先查询；不确定关键词可用空 query 分页浏览，按 nextOffset 继续。',
    properties: {
      query: { type: 'string', description: '关键词；空字符串浏览全部已确认记忆' },
      offset: { type: 'integer', minimum: 0, description: '分页起点，首次为 0' },
    },
    required: ['query'],
  },
  {
    name: 'propose_memory',
    description:
      '提出一条值得长期保留的工作区约定或事实，尤其在用户要求记住时使用。只会创建待确认候选，必须明确告知用户去长期记忆页面确认；禁止保存密码、密钥或推测性事实。',
    properties: { content: { type: 'string', description: '简洁完整的事实或约定，最多 4000 字' } },
    required: ['content'],
  },
  {
    name: 'list_directory',
    description: '列出目录中的文件和子目录，最多 200 项。',
    properties: { path: { type: 'string', description: '相对工作区的目录，根目录使用 .' } },
    required: ['path'],
  },
  {
    name: 'read_file',
    description: '读取 UTF-8 文本文件，最多 64 KB；不可读取二进制文件。',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  {
    name: 'search_files',
    description: '在指定目录的文本文件中递归搜索字面文本（非正则），最多 50 条结果。',
    properties: { path: { type: 'string' }, query: { type: 'string' } },
    required: ['path', 'query'],
  },
  {
    name: 'write_file',
    description:
      '创建或完整替换 UTF-8 文件（父目录必须存在）。工作区模式需要用户在页面审批后才会写入；被拒绝后不得绕过审批。',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  {
    name: 'run_command',
    description:
      '在本机运行 Shell 命令，仅完全权限可用。默认 cwd 为工作区；等待命令完成或用户停止，不限制执行时长。只返回末尾日志，需要完整日志时重定向到文件。',
    properties: { command: { type: 'string' }, cwd: { type: 'string' } },
    required: ['command'],
  },
];

export function createWorkspaceTools(execution: AgentExecutionContext, signal: AbortSignal) {
  return definitions
    .filter((definition) => {
      if (definition.name === 'update_plan') return !!execution.getPlan;
      if (definition.name === 'run_command') return execution.permissionMode === 'full-access';
      if (definition.name === 'write_file') return execution.permissionMode !== 'read-only';
      return true;
    })
    .map((definition) =>
      tool(
        async function* (input, config) {
          const id = config.toolCall?.id;
          if (!id) throw new Error('Missing tool call ID');
          yield '正在检查权限和参数';
          const result = yield* execution.execute({ id, name: definition.name, input }, signal);
          return new ToolMessage({
            tool_call_id: id,
            name: definition.name,
            content: result.content,
            status: result.failed ? 'error' : 'success',
          });
        },
        {
          name: definition.name,
          description: definition.description,
          schema: {
            type: 'object',
            properties: definition.properties,
            required: definition.required,
            additionalProperties: false,
          },
        },
      ),
    );
}
