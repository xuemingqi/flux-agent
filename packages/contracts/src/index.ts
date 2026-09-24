import { z } from 'zod';

export const createRunSchema = z.object({ content: z.string().trim().min(1).max(32_000) });
export const createSteeringSchema = createRunSchema
  .extend({
    /** 客户端生成的消息标识；网络重试不会重复插入。 */
    id: z.uuid(),
  })
  .strict();
export type CreateSteering = z.infer<typeof createSteeringSchema>;
export const steeringMessageSchema = createSteeringSchema.extend({
  /** applied 表示已纳入模型请求；未处理即结束时保留为 not_applied。 */
  status: z.enum(['pending', 'applied', 'not_applied']),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
});
export type SteeringMessage = z.infer<typeof steeringMessageSchema>;

export const permissionModeSchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace-write';
export const permissionLabels: Record<PermissionMode, string> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'full-access': '完全权限',
};
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  /**
   * 从列表移除的时间；会话同步删除，目录和长期记忆保留。
   */
  archivedAt: z.string().nullable().default(null),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const filePreviewSchema = z.object({
  /** 用户打开的文件实际路径，与会话的工作区权限一致。 */
  path: z.string(),
  /** 仅供界面预览，不写入模型消息历史。 */
  content: z.string(),
});
export type FilePreview = z.infer<typeof filePreviewSchema>;
export const createWorkspaceSchema = z.object({ rootPath: z.string().trim().min(1).max(4096) });
export const renameWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const createThreadSchema = z.object({ workspaceId: z.string().optional() });
export const renameThreadSchema = z.object({ title: z.string().trim().min(1).max(100) }).strict();
export const updatePermissionSchema = z.object({
  mode: permissionModeSchema,
  confirmFullAccess: z.boolean().default(false),
});
export const approvalDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) });
export const approvalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  workspaceId: z.string(),
  inputHash: z.string(),
  path: z.string(),
  before: z.string().nullable(),
  after: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  createdAt: z.string(),
  /** 新审批持续等待用户决定；旧记录兼容原有过期时间。 */
  expiresAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const memoryStateSchema = z.enum(['candidate', 'active', 'disabled']);
export const memoryInputSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  pinned: z.boolean().default(false),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export const memoryUpdateSchema = memoryInputSchema.extend({
  state: memoryStateSchema,
  version: z.number().int().positive(),
});
export const memoryVersionSchema = z.object({ version: z.number().int().positive() });
export const memorySchema = memoryInputSchema.extend({
  id: z.string(),
  workspaceId: z.string(),
  state: memoryStateSchema,
  source: z.enum(['user', 'agent']),
  sourceThreadId: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type MemoryEntry = z.infer<typeof memorySchema>;
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

// 原生消息与页面展示步骤分开存储，保留工具调用与返回值的关联。
export const modelMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string(), steeringId: z.string().optional() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    reasoning: z.string().optional(),
    /** 供应商的正常结束或长度截断原因，用于故障定位。 */
    finishReason: z.string().optional(),
    toolCalls: z
      .array(z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }))
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string(),
    name: z.string().optional(),
    status: z.enum(['success', 'error']).optional(),
  }),
]);
export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const contextRecordSchema = z.object({
  step: z.number().int().positive(),
  budgetTokens: z.number().int(),
  /**
   * 当前请求采用的模型窗口，旧记录可能没有该字段。
   */
  contextWindowTokens: z.number().int().positive().optional(),
  estimatedTokens: z.number().int(),
  keptTurns: z.number().int(),
  omittedTurns: z.number().int(),
  truncatedToolResults: z.number().int(),
  memories: z.array(z.object({ id: z.string(), version: z.number().int(), excerpt: z.string() })),
  /** 已由摘要覆盖的原生消息数量；完整记录仍保留。 */
  summarizedMessages: z.number().int().nonnegative().optional(),
  compressionError: z.string().optional(),
  /**
   * 当前没有可安全压缩的内容时说明原因，避免重复请求模型生成无效摘要。
   */
  compressionWarning: z.string().optional(),
});
export type ContextRecord = z.infer<typeof contextRecordSchema>;

export const contextCompactionSchema = z.object({
  /** 历次摘要累计覆盖的原生消息前缀长度，后续轮次直接复用。 */
  coveredMessages: z.number().int().nonnegative(),
  summary: z.string(),
  createdAt: z.string(),
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  /**
   * 整个请求的压缩目标，包含摘要、原文、系统提示、工具和记忆。
   */
  targetTokens: z.number().int().positive().optional(),
  /**
   * 未达到目标时说明必须保留的内容超出预算，不能宣称压缩达标。
   */
  warning: z.string().optional(),
});
export type ContextCompaction = z.infer<typeof contextCompactionSchema>;

export const contextCompressionProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type ContextCompressionProgress = z.infer<typeof contextCompressionProgressSchema>;

export const runStatusSchema = z.enum([
  'running',
  'waiting_approval',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export function isRunActive(status: RunStatus): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'cancelling';
}

export const tokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const apiErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

export const messageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

// 步骤按实际发生顺序保存；工具 ID 用于关联并行调用的开始、进度和结果。
export const runStepSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('text'), content: z.string(), createdAt: z.string() }),
  z.object({ id: z.string(), kind: z.literal('reasoning'), content: z.string(), createdAt: z.string() }),
  z.object({ id: z.string(), kind: z.literal('steering'), content: z.string(), createdAt: z.string() }),
  z.object({
    id: z.string(),
    kind: z.literal('tool'),
    name: z.string(),
    input: z.string(),
    output: z.string(),
    progress: z.array(z.string()),
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  }),
]);
export type RunStep = z.infer<typeof runStepSchema>;

export const planStepSchema = z
  .object({
    /** 同一计划内保持稳定，便于后续关联具体工具或产物。 */
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'skipped']),
  })
  .strict();
export const updatePlanSchema = z
  .object({
    /** 首次创建传 0，之后传宿主返回的版本，防止并行调用覆盖进度。 */
    version: z.number().int().nonnegative(),
    explanation: z.string().trim().min(1).max(1000),
    steps: z.array(planStepSchema).min(1).max(12),
  })
  .strict();
export type UpdatePlan = z.infer<typeof updatePlanSchema>;
export const runPlanSchema = updatePlanSchema.extend({
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

export const feedbackInputSchema = z
  .object({
    /** null 表示撤回评价，也允许只留下文字意见。 */
    rating: z.enum(['helpful', 'unhelpful']).nullable(),
    comment: z.string().trim().max(2000),
    /** 当前反馈版本；从未评价时传 0。撤回后也保留版本以避免旧页面覆盖。 */
    version: z.number().int().nonnegative(),
  })
  .strict();
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
export const runFeedbackSchema = feedbackInputSchema.extend({
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export type RunFeedback = z.infer<typeof runFeedbackSchema>;
export const agentIdentitySchema = z.object({ name: z.string(), version: z.string() });
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export const agentTaskSchema = z.object({
  /**
   * 创建此任务的委派调用，用于在对应工具旁展示进度；旧记录没有该字段。
   */
  parentToolCallId: z.string().optional(),
  /** 子任务独立压缩上下文时的进度，旧记录没有该字段。 */
  compression: contextCompressionProgressSchema.nullable().optional(),
  /** 子任务拥有独立上下文，ID 同时作为工具执行凭证的命名空间。 */
  id: z.string(),
  name: z.string(),
  task: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  output: z.string(),
  steps: z.array(runStepSchema),
  messages: z.array(modelMessageSchema),
  context: z.array(contextRecordSchema),
  compaction: contextCompactionSchema.nullable(),
  usage: tokenUsageSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;
export const delegateTasksSchema = z
  .object({
    /** 并行适用于相互独立的任务；串行将前序结果提供给后续任务。 */
    mode: z.enum(['parallel', 'sequential']),
    tasks: z
      .array(z.object({ name: z.string().trim().min(1).max(80), task: z.string().trim().min(1).max(32000) }).strict())
      .min(1),
  })
  .strict();

export const runSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  workspaceId: z.string(),
  permissionMode: permissionModeSchema,
  approvals: z.array(approvalSchema),
  assistantMessageId: z.string(),
  status: runStatusSchema,
  output: z.string(),
  steps: z.array(runStepSchema),
  context: z.array(contextRecordSchema).default([]),
  /** 运行所属 Agent 定义版本；升级前的历史无法补造，记为 null。 */
  agent: agentIdentitySchema.nullable().default(null),
  /** 本轮最新计划和用户反馈随运行快照原子保存，旧记录兼容为空。 */
  plan: runPlanSchema.nullable().default(null),
  feedback: runFeedbackSchema.nullable().default(null),
  /** 生成过程中提交的用户补充，与运行一起持久化；旧记录默认为空。 */
  steering: z.array(steeringMessageSchema).default([]),
  /** 最近一次压缩快照，原始会话和工具记录不删除。 */
  compaction: contextCompactionSchema.nullable().default(null),
  /** 主 Agent 编排的子任务及其独立执行记录。 */
  subagents: z.array(agentTaskSchema).default([]),
  /** 当前摘要压缩进度；完成、失败和重启后清空，不代表任务结束。 */
  compression: contextCompressionProgressSchema.nullable().default(null),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  error: apiErrorSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const threadSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  permissionMode: permissionModeSchema,
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadSchema = threadSummarySchema.extend({
  messages: z.array(messageSchema),
  runs: z.array(runSchema),
});
export type Thread = z.infer<typeof threadSchema>;

// 每次订阅先发完整快照，后续只推增量；重连不依赖易失的 token 事件回放。
export const runEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.snapshot'), run: runSchema }),
  z.object({ type: z.literal('run.delta'), runId: z.string(), text: z.string(), steps: z.array(runStepSchema) }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;

export const sessionSchema = z.object({
  token: z.string(),
  model: z.string().nullable(),
  configured: z.boolean(),
  storage: z.enum(['memory', 'sqlite']),
});
export type Session = z.infer<typeof sessionSchema>;

export const modelEndpointSchema = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url())
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, '请输入不含凭据、查询参数和片段的 HTTP 或 HTTPS 接口地址。')
  .transform((value) => value.replace(/\/+$/, ''));

export const saveModelSettingsSchema = z.object({
  baseUrl: modelEndpointSchema,
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(8192).default(''),
  /**
   * 留空时从服务商元数据或已核实的官方规格获取；手动值优先。
   */
  contextWindowTokens: z.number().int().min(8192).max(2_000_000).optional(),
  maxOutputTokens: z
    .number()
    .int()
    .min(0)
    .max(2_000_000)
    .refine((value) => value === 0 || value >= 256)
    .default(0),
});
export type SaveModelSettings = z.infer<typeof saveModelSettingsSchema>;

export const detectModelContextSchema = saveModelSettingsSchema.pick({ baseUrl: true, model: true, apiKey: true });
export type DetectModelContext = z.infer<typeof detectModelContextSchema>;

export const modelContextSchema = z.object({
  /**
   * 未识别时必须手动填写，不能静默套用小窗口。
   */
  contextWindowTokens: z.number().int().min(8192).max(2_000_000).nullable(),
  /**
   * 区分服务商实时元数据与内置官方规格。
   */
  source: z.enum(['provider', 'official']).nullable(),
});
export type ModelContext = z.infer<typeof modelContextSchema>;

export const modelSettingsSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  configured: z.boolean(),
  contextWindowTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
