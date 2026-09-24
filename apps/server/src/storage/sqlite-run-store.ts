import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  isRunActive,
  runSchema,
  modelMessageSchema,
  type ModelMessage,
  type Run,
  type Thread,
  type Workspace,
} from '@flux-agent/contracts';
import type { RunStore, ToolExecution } from '../runs/run-store.js';
import * as schema from './schema.js';
import { SqliteModelSettingsStore } from './sqlite-model-settings-store.js';
import { SqliteMemoryStore } from './sqlite-memory-store.js';

/**
 * 当前单进程版本在内存中持有会话对象，关键变化以事务落库。
 * 数据库记录是重启恢复的来源，绝不自动重放工具调用。
 */
export class SqliteRunStore implements RunStore {
  readonly kind = 'sqlite' as const;
  readonly threads = new Map<string, Thread>();
  readonly runs = new Map<string, Run>();
  readonly workspaces = new Map<string, Workspace>();
  private readonly connection;
  private readonly database;
  readonly modelSettings: SqliteModelSettingsStore;
  readonly memory: SqliteMemoryStore;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new Database(path);
    chmodSync(path, 0o600);
    // 当前运行状态由单进程拥有，阻止第二个服务误将仍活跃的运行恢复为中断。
    this.connection.pragma('busy_timeout = 5000');
    this.connection.pragma('locking_mode = EXCLUSIVE');
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('foreign_keys = ON');
    this.database = drizzle(this.connection);
    migrate(this.database, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
    this.modelSettings = new SqliteModelSettingsStore(this.database);
    this.memory = new SqliteMemoryStore(this.database);
    this.restore();
  }

  saveWorkspace(workspace: Workspace): void {
    this.database
      .insert(schema.workspaces)
      .values(workspace)
      .onConflictDoUpdate({
        target: schema.workspaces.id,
        set: { name: workspace.name, archivedAt: workspace.archivedAt },
      })
      .run();
    this.workspaces.set(workspace.id, workspace);
  }

  archiveWorkspace(workspace: Workspace): void {
    this.database.transaction((transaction) => {
      const threadIds = transaction
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(eq(schema.threads.workspaceId, workspace.id));
      const runIds = transaction
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(inArray(schema.runs.threadId, threadIds));
      // 记忆内容独立保留，清除已删除的来源链接，避免悬空引用和外键阻止会话删除。
      transaction
        .update(schema.memories)
        .set({ sourceThreadId: null, sourceRunId: null })
        .where(eq(schema.memories.workspaceId, workspace.id))
        .run();
      transaction.delete(schema.approvals).where(inArray(schema.approvals.runId, runIds)).run();
      transaction.delete(schema.executions).where(inArray(schema.executions.runId, runIds)).run();
      transaction.delete(schema.modelHistories).where(inArray(schema.modelHistories.runId, runIds)).run();
      transaction.delete(schema.messages).where(inArray(schema.messages.threadId, threadIds)).run();
      transaction.delete(schema.runs).where(inArray(schema.runs.threadId, threadIds)).run();
      transaction.delete(schema.threads).where(eq(schema.threads.workspaceId, workspace.id)).run();
      transaction
        .update(schema.workspaces)
        .set({ archivedAt: workspace.archivedAt })
        .where(eq(schema.workspaces.id, workspace.id))
        .run();
    });
    // 提交成功后才更新进程内视图，事务失败时仍可继续访问原会话。
    for (const run of this.runs.values()) if (run.workspaceId === workspace.id) this.runs.delete(run.id);
    for (const thread of this.threads.values()) if (thread.workspaceId === workspace.id) this.threads.delete(thread.id);
    this.workspaces.set(workspace.id, workspace);
  }

  saveThread(thread: Thread): void {
    this.saveSnapshot(thread, thread.runs);
  }

  deleteThread(id: string): void {
    this.database.transaction((transaction) => {
      const runIds = transaction.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.threadId, id));
      transaction
        .update(schema.memories)
        .set({ sourceThreadId: null, sourceRunId: null })
        .where(eq(schema.memories.sourceThreadId, id))
        .run();
      transaction.delete(schema.approvals).where(inArray(schema.approvals.runId, runIds)).run();
      transaction.delete(schema.executions).where(inArray(schema.executions.runId, runIds)).run();
      transaction.delete(schema.modelHistories).where(inArray(schema.modelHistories.runId, runIds)).run();
      transaction.delete(schema.messages).where(eq(schema.messages.threadId, id)).run();
      transaction.delete(schema.runs).where(eq(schema.runs.threadId, id)).run();
      transaction.delete(schema.threads).where(eq(schema.threads.id, id)).run();
    });
    for (const run of this.threads.get(id)!.runs) this.runs.delete(run.id);
    this.threads.delete(id);
  }

  saveRun(thread: Thread, run: Run): void {
    this.saveSnapshot(thread, [run]);
  }

  /**
   * 流式更新只写本轮快照和消息，不反复重写历史轮次。
   */
  private saveSnapshot(thread: Thread, runs: Run[]): void {
    const { messages: _messages, runs: _runs, ...summary } = thread;
    const runIds = new Set(runs.map((run) => run.id));
    const messages = thread.messages.filter((message) => runIds.has(message.runId));
    this.database.transaction((transaction) => {
      transaction
        .insert(schema.threads)
        .values(summary)
        .onConflictDoUpdate({ target: schema.threads.id, set: summary })
        .run();
      for (const run of runs) {
        transaction
          .insert(schema.runs)
          .values({ id: run.id, threadId: thread.id, snapshot: run })
          .onConflictDoUpdate({ target: schema.runs.id, set: { snapshot: run } })
          .run();
        for (const approval of run.approvals) {
          transaction
            .insert(schema.approvals)
            .values({ id: approval.id, runId: run.id, snapshot: approval })
            .onConflictDoUpdate({ target: schema.approvals.id, set: { snapshot: approval } })
            .run();
        }
      }
      for (const message of messages) {
        transaction
          .insert(schema.messages)
          .values({ id: message.id, threadId: thread.id, runId: message.runId, snapshot: message })
          .onConflictDoUpdate({ target: schema.messages.id, set: { snapshot: message } })
          .run();
      }
    });
    this.threads.set(thread.id, thread);
  }

  getExecution(runId: string, toolCallId: string): ToolExecution | undefined {
    return this.database
      .select()
      .from(schema.executions)
      .where(and(eq(schema.executions.runId, runId), eq(schema.executions.toolCallId, toolCallId)))
      .get();
  }

  saveExecution(execution: ToolExecution): void {
    this.database
      .insert(schema.executions)
      .values(execution)
      .onConflictDoUpdate({
        target: [schema.executions.runId, schema.executions.toolCallId],
        set: execution,
      })
      .run();
  }

  close(): void {
    this.connection.close();
  }

  getModelHistory(runId: string): ModelMessage[] | undefined {
    const row = this.database.select().from(schema.modelHistories).where(eq(schema.modelHistories.runId, runId)).get();
    return row ? modelMessageSchema.array().parse(row.messages) : undefined;
  }

  saveModelHistory(runId: string, messages: ModelMessage[]): void {
    this.database
      .insert(schema.modelHistories)
      .values({ runId, messages })
      .onConflictDoUpdate({ target: schema.modelHistories.runId, set: { messages } })
      .run();
  }

  /**
   * 恢复展示状态；在崩溃窗口中的副作用需人工检查，不推断成功或再次执行。
   */
  private restore(): void {
    for (const workspace of this.database.select().from(schema.workspaces).all())
      this.workspaces.set(workspace.id, workspace);
    for (const thread of this.database.select().from(schema.threads).all())
      this.threads.set(thread.id, { ...thread, messages: [], runs: [] });
    const now = new Date().toISOString();
    const recovered = new Set<string>();
    for (const row of this.database
      .select()
      .from(schema.runs)
      .orderBy(sql`rowid`)
      .all()) {
      const run = runSchema.parse(row.snapshot);
      if (isRunActive(run.status)) {
        run.compression = null;
        recovered.add(run.threadId);
        run.status = 'interrupted';
        run.finishedAt = now;
        for (const task of run.subagents) {
          task.compression = null;
          if (task.status !== 'running' && task.status !== 'queued') continue;
          task.status = 'interrupted';
          task.finishedAt = now;
          task.error = '服务重启，子任务已中断，不会自动重放。';
          for (const step of task.steps)
            if (step.kind === 'tool' && step.status === 'running') {
              step.status = 'interrupted';
              step.finishedAt = now;
            }
        }
        for (const entry of run.steering) if (entry.status === 'pending') entry.status = 'not_applied';
        run.error = {
          code: 'RUN_INTERRUPTED',
          message: '服务已重启，本轮已中断。未完成的文件或命令操作请检查实际状态；不会自动重试。',
        };
        for (const approval of run.approvals) {
          if (approval.status === 'pending') {
            approval.status = 'expired';
            approval.decidedAt = now;
          }
        }
        for (const step of run.steps) {
          if (step.kind === 'tool' && step.status === 'running') {
            step.status = 'interrupted';
            step.finishedAt = now;
            step.output = '执行中断，请检查目标状态。';
          }
        }
      }
      this.runs.set(run.id, run);
      this.threads.get(run.threadId)!.runs.push(run);
    }
    for (const message of this.database
      .select()
      .from(schema.messages)
      .orderBy(sql`rowid`)
      .all())
      this.threads.get(message.threadId)!.messages.push(message.snapshot);
    for (const id of recovered) this.saveThread(this.threads.get(id)!);
    this.database
      .update(schema.executions)
      .set({ status: 'interrupted' })
      .where(eq(schema.executions.status, 'started'))
      .run();
  }
}
