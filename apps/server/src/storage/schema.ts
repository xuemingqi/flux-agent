import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import type { Approval, Message, Run, PermissionMode, MemoryEntry, ModelMessage } from '@flux-agent/contracts';
import type { ToolExecution } from '../runs/run-store.js';

export const modelSettings = sqliteTable('model_settings', {
  /**
   * 当前默认模型配置；保留独立表以便后续扩展多个模型。
   */
  id: text('id').primaryKey(),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  /**
   * 本地凭据，绝不经 API 返回；数据库目录和文件限制为当前用户访问。
   */
  apiKey: text('api_key').notNull(),
  contextWindowTokens: integer('context_window_tokens').notNull().default(32768),
  maxOutputTokens: integer('max_output_tokens').notNull().default(4096),
  updatedAt: text('updated_at').notNull(),
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  createdAt: text('created_at').notNull(),
  /**
   * 移除时间；会话同步删除，保留目录及记忆，供重新添加工作区使用。
   */
  archivedAt: text('archived_at'),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  permissionMode: text('permission_mode').$type<PermissionMode>().notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id),
  /**
   * 完整展示快照，含思考、工具过程和本轮固定权限。
   */
  snapshot: text('snapshot', { mode: 'json' }).$type<Run>().notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  snapshot: text('snapshot', { mode: 'json' }).$type<Message>().notNull(),
});

export const modelHistories = sqliteTable('model_histories', {
  /** 每轮只保存新增的原生消息，不重复存储已经发送的历史。 */
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id),
  messages: text('messages', { mode: 'json' }).$type<ModelMessage[]>().notNull(),
});

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    content: text('content').notNull(),
    state: text('state').$type<MemoryEntry['state']>().notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull(),
    source: text('source').$type<MemoryEntry['source']>().notNull(),
    sourceThreadId: text('source_thread_id').references(() => threads.id),
    sourceRunId: text('source_run_id').references(() => runs.id),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    confirmedAt: text('confirmed_at'),
    expiresAt: text('expires_at'),
  },
  (table) => [index('memories_workspace_state').on(table.workspaceId, table.state)],
);

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  snapshot: text('snapshot', { mode: 'json' }).$type<Approval>().notNull(),
});

export const executions = sqliteTable(
  'tool_executions',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    toolCallId: text('tool_call_id').notNull(),
    name: text('name').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').$type<ToolExecution['status']>().notNull(),
    result: text('result'),
  },
  (table) => [primaryKey({ columns: [table.runId, table.toolCallId] })],
);
