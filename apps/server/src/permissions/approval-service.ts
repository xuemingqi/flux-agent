import type { Approval, Run } from '@flux-agent/contracts';
import { ApplicationError } from '../api/application-error.js';

export class ApprovalService {
  private readonly waiting = new Map<string, { approval: Approval; settle(status: Approval['status']): void }>();

  constructor(private readonly changed: (run: Run) => void) {}

  /**
   * 每次审批绑定运行、调用、参数摘要与原文；只授权本次修改。
   */
  async request(
    run: Run,
    details: Pick<Approval, 'toolCallId' | 'inputHash' | 'path' | 'before' | 'after'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const approval: Approval = {
      ...details,
      id: crypto.randomUUID(),
      runId: run.id,
      workspaceId: run.workspaceId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      decidedAt: null,
    };
    run.approvals.push(approval);
    run.status = 'waiting_approval';
    return new Promise<boolean>((resolve, reject) => {
      const settle = (status: Approval['status']) => {
        if (approval.status !== 'pending') return;
        approval.status = status;
        approval.decidedAt = new Date().toISOString();
        signal.removeEventListener('abort', aborted);
        this.waiting.delete(approval.id);
        if (run.status === 'waiting_approval' && !run.approvals.some((entry) => entry.status === 'pending'))
          run.status = 'running';
        // 必须先持久化决定，再释放等待工具；数据库故障时禁止执行。
        try {
          this.changed(run);
          resolve(status === 'approved');
        } catch (error) {
          reject(error);
        }
      };
      const aborted = () => settle('cancelled');
      signal.addEventListener('abort', aborted, { once: true });
      this.waiting.set(approval.id, { approval, settle });
      try {
        this.changed(run);
      } catch (error) {
        signal.removeEventListener('abort', aborted);
        this.waiting.delete(approval.id);
        reject(error);
      }
    });
  }

  decide(runId: string, id: string, decision: 'approved' | 'denied'): void {
    const pending = this.waiting.get(id);
    if (!pending || pending.approval.runId !== runId)
      throw new ApplicationError('APPROVAL_NOT_PENDING', '该审批已处理、已过期或不属于此运行。', 409);
    if (pending.approval.expiresAt && Date.parse(pending.approval.expiresAt) <= Date.now()) {
      pending.settle('expired');
      throw new ApplicationError('APPROVAL_EXPIRED', '审批已过期，请重新发起操作。', 409);
    }
    pending.settle(decision);
  }
}
