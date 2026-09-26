import type {
  PermissionMode,
  TokenUsage,
  MemoryEntry,
  ModelMessage,
  ContextRecord,
  RunPlan,
  AgentIdentity,
  SteeringMessage,
  ContextCompaction,
  ContextCompressionProgress,
  AgentTask,
  AgentCommunication,
} from '@flux-agent/contracts';

export interface ToolRequest {
  /**
   * 模型本次调用的稳定标识，用于审批和执行凭证关联。
   */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  content: string;
  failed: boolean;
}

export interface SteeringInbox {
  /** 新消息持久化后通知；仅模型生成可立即中止，已开始的工具执行完成后再切换。 */
  subscribe?(listener: () => void): () => void;
  /** 读取待补充消息，不提前声明已经送入模型。 */
  pending(): SteeringMessage[];
  /** 仅标记本次请求实际携带的消息，按其顺序记录展示步骤。 */
  apply(ids: string[]): void;
  /** 原子关闭当前轮次的收件窗口；仍有待处理消息时返回 false。 */
  finish(): boolean;
}

export interface AgentExecutionContext {
  workspacePath: string;
  permissionMode: PermissionMode;
  /** 子 Agent 的调用命名空间，避免供应商重用调用 ID 时混入父级工具轨迹。 */
  toolCallNamespace?: string;
  /** 父任务调整方向时，子任务在最小工具单元完成后让出执行。 */
  interruption?: { requested(): boolean; subscribe?(listener: () => void): () => void };
  /** 每次模型请求重新检索，禁用或删除的记忆不会进入后续请求。 */
  getMemories?(): MemoryEntry[];
  /** 每次模型调用读取宿主最新计划，避免历史裁剪后丢失执行进度。 */
  getPlan?(): RunPlan | null;
  /** 宿主保存上下文摘要和本轮原生消息，不将框架类型泄漏至业务存储。 */
  recordContext?(record: ContextRecord): void;
  saveMessages?(messages: ModelMessage[]): void;
  /** 上轮成功任务留下的摘要，按原生消息前缀索引复用。 */
  compaction?: ContextCompaction | null;
  recordCompaction?(compaction: ContextCompaction): void;
  /** 摘要分块进行中实时通知宿主，结束后清空，避免静默等待。 */
  recordCompression?(progress: ContextCompressionProgress | null): void;
  /** 子 Agent 的状态与过程由宿主持久化和推送，子任务不直接向用户输出。 */
  recordSubagent?(task: AgentTask, durable?: boolean): void;
  /** 同一次委派内的协作通道；不授予工具权限，也不能派生新 Agent。 */
  collaboration?: {
    roster(): { id: string; name: string; task: string; status: AgentTask['status'] }[];
    pending(): AgentCommunication[];
    send(toAgentId: string, content: string): AgentCommunication;
    delivered(ids: string[]): void;
    wait(timeoutMs: number, signal: AbortSignal): Promise<void>;
    finish(): boolean;
  };
  /** 可选的本轮消息收件箱，由宿主管理持久化和关闭时机。 */
  steering?: SteeringInbox;
  /**
   * 由宿主提供受权限约束的工具执行入口，与 LangChain、HTTP 解耦。
   */
  execute(request: ToolRequest, signal: AbortSignal): AsyncGenerator<string, ToolResult>;
}

export type ConversationMessage = ModelMessage;

export type AgentEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.start'; id: string; name: string; input: string }
  | { type: 'tool.progress'; id: string; text: string }
  | { type: 'tool.end'; id: string; output: string; failed: boolean }
  | { type: 'usage'; usage: TokenUsage };

export interface AgentRuntime {
  /** 固定本轮 Agent 定义标识，用于反馈追溯；自定义运行时可暂不提供。 */
  readonly identity?: AgentIdentity;
  /** 运行时须支持步骤间读取补充消息及结束前关闭收件，才能启用插话。 */
  readonly supportsSteering?: boolean;
  /**
   * 执行一轮 Agent，取消信号由运行管理层控制，不绑定 HTTP 连接。
   */
  stream(
    messages: ConversationMessage[],
    signal: AbortSignal,
    execution?: AgentExecutionContext,
  ): AsyncIterable<AgentEvent>;
}
