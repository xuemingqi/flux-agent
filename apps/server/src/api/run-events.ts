import { isRunActive, type Run, type RunEvent } from '@flux-agent/contracts';
import type { SSEStreamingApi } from 'hono/streaming';
import type { RunManager } from '../runs/run-manager.js';

/**
 * 连接只负责订阅；慢连接合并文本增量，断开不会终止后台运行。
 */
export async function streamRunEvents(stream: SSEStreamingApi, manager: RunManager, runId: string): Promise<void> {
  let dirty = true;
  let wake: (() => void) | undefined;
  let previous: Run | undefined;
  const notify = () => {
    dirty = true;
    wake?.();
  };
  const unsubscribe = manager.subscribe(runId, notify);
  const heartbeat = setInterval(notify, 15_000);
  stream.onAbort(notify);

  const write = (event: RunEvent) => stream.writeSSE({ event: 'run', data: JSON.stringify(event) });
  try {
    while (!stream.aborted) {
      dirty = false;
      const run = manager.getRun(runId);
      if (
        !previous ||
        run.status !== previous.status ||
        run.context.length !== previous.context.length ||
        run.plan?.version !== previous.plan?.version ||
        run.feedback?.version !== previous.feedback?.version ||
        JSON.stringify(run.steering) !== JSON.stringify(previous.steering) ||
        JSON.stringify(run.compaction) !== JSON.stringify(previous.compaction) ||
        JSON.stringify(run.compression) !== JSON.stringify(previous.compression) ||
        JSON.stringify(run.subagents) !== JSON.stringify(previous.subagents) ||
        run.usage?.totalTokens !== previous.usage?.totalTokens ||
        JSON.stringify(run.approvals) !== JSON.stringify(previous.approvals)
      ) {
        await write({ type: 'run.snapshot', run });
      } else {
        const changedSteps = run.steps.filter(
          (step, index) => JSON.stringify(step) !== JSON.stringify(previous!.steps[index]),
        );
        const text = run.output.slice(previous.output.length);
        if (text || changedSteps.length) await write({ type: 'run.delta', runId, text, steps: changedSteps });
        else await stream.write(': heartbeat\n\n');
      }
      previous = run;
      if (!isRunActive(run.status) || stream.aborted) break;
      if (!dirty)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
    }
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
  }
}
