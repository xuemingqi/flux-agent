import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { isRunActive, type Workspace } from '@flux-agent/contracts';
import type { RunStore } from '../runs/run-store.js';
import { ApplicationError } from '../api/application-error.js';

export class WorkspaceService {
  constructor(private readonly store: RunStore) {}

  list(): Workspace[] {
    return [...this.store.workspaces.values()].map((workspace) => ({ ...workspace }));
  }

  /**
   * 只接受用户显式选择的已存在目录；不从模型输入创建工作区。
   */
  create(path: string): Workspace {
    if (!isAbsolute(path)) throw new ApplicationError('INVALID_WORKSPACE', '请输入工作区的绝对路径。');
    let rootPath: string;
    try {
      rootPath = realpathSync(path);
      if (!statSync(rootPath).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new ApplicationError('INVALID_WORKSPACE', '工作区目录不存在或无法访问。');
    }
    const existing = this.list().find((workspace) => workspace.rootPath === rootPath);
    if (existing) {
      if (existing.archivedAt) {
        existing.archivedAt = null;
        this.store.saveWorkspace(existing);
      }
      return existing;
    }
    const workspace = {
      id: crypto.randomUUID(),
      name: basename(rootPath) || rootPath,
      rootPath,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    this.store.saveWorkspace(workspace);
    return workspace;
  }

  require(id: string): Workspace {
    const workspace = this.store.workspaces.get(id);
    if (!workspace) throw new ApplicationError('WORKSPACE_NOT_FOUND', '工作区不存在。', 404);
    return workspace;
  }

  /** 修改展示名称，不移动实际目录。 */
  rename(id: string, name: string): Workspace {
    const workspace = { ...this.require(id), name };
    this.store.saveWorkspace(workspace);
    return workspace;
  }

  /**
   * 移除工作区时同时删除会话；实际目录及长期记忆保留，任务执行中禁止清理。
   */
  archive(id: string): Workspace {
    const workspace = this.require(id);
    if ([...this.store.runs.values()].some((run) => run.workspaceId === id && isRunActive(run.status)))
      throw new ApplicationError('WORKSPACE_BUSY', '此工作区有正在运行的任务，请结束后再移除。', 409);
    const archived = { ...workspace, archivedAt: workspace.archivedAt ?? new Date().toISOString() };
    this.store.archiveWorkspace(archived);
    return archived;
  }
}
