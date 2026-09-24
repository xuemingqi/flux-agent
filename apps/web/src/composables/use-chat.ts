import { computed, onMounted, onUnmounted, ref } from 'vue';
import { z } from 'zod';
import {
  isRunActive,
  runEventSchema,
  runSchema,
  threadSchema,
  threadSummarySchema,
  workspaceSchema,
  type Workspace,
  type PermissionMode,
  type Run,
  type Session,
  type Thread,
  type ThreadSummary,
  type FeedbackInput,
} from '@flux-agent/contracts';
import { ApiRequestError, connect, request } from '../api/client';

export function useChat() {
  const session = ref<Session>();
  const allThreads = ref<ThreadSummary[]>([]);
  const workspaces = ref<Workspace[]>([]);
  const workspaceId = ref('');
  const threads = computed(() => allThreads.value.filter((entry) => entry.workspaceId === workspaceId.value));
  const workspace = computed(() => workspaces.value.find((entry) => entry.id === workspaceId.value));
  const approvalPending = ref('');
  const thread = ref<Thread>();
  const draft = ref('');
  const error = ref('');
  const connection = ref('');
  const pending = ref(false);
  const loading = ref(true);
  const activeRun = computed(() => thread.value?.runs.find((run) => isRunActive(run.status)));
  let events: EventSource | undefined;
  let selectionVersion = 0;
  let frame = 0;
  let streamedRun: Run | undefined;
  let steeringAttempt: { runId: string; content: string; id: string } | undefined;

  function disconnect() {
    events?.close();
    events = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    streamedRun = undefined;
    connection.value = '';
  }

  function applyStreamedRun() {
    frame = 0;
    const run = streamedRun;
    if (!run || thread.value?.id !== run.threadId) return;
    const index = thread.value.runs.findIndex((entry) => entry.id === run.id);
    if (index >= 0) thread.value.runs[index] = { ...run };
    const message = thread.value.messages.find((entry) => entry.id === run.assistantMessageId);
    if (message) message.content = run.output;
  }

  function subscribe(run: Run) {
    disconnect();
    streamedRun = { ...run };
    const source = new EventSource(`/api/runs/${run.id}/events`);
    events = source;
    source.onopen = () => {
      connection.value = '';
    };
    source.onerror = () => {
      connection.value = '连接中断，正在重连。若服务已重启，请刷新页面。';
    };
    source.addEventListener('run', (event: MessageEvent<string>) => {
      if (events !== source) return;
      try {
        const update = runEventSchema.parse(JSON.parse(event.data));
        if (update.type === 'run.snapshot') streamedRun = update.run;
        else if (streamedRun?.id === update.runId) {
          streamedRun.output += update.text;
          // 替换数组，避免 rAF 提交前修改已经展示的运行快照。
          const steps = [...streamedRun.steps];
          for (const step of update.steps) {
            const index = steps.findIndex((entry) => entry.id === step.id);
            if (index < 0) steps.push(step);
            else steps[index] = step;
          }
          streamedRun.steps = steps;
        }
        if (streamedRun && !isRunActive(streamedRun.status)) {
          cancelAnimationFrame(frame);
          applyStreamedRun();
          disconnect();
        } else if (!frame) frame = requestAnimationFrame(applyStreamedRun);
      } catch {
        error.value = '无法解析服务端事件，请刷新页面后重试。';
        disconnect();
      }
    });
  }

  async function refreshThreads() {
    allThreads.value = await request('/threads', threadSummarySchema.array());
  }

  async function selectThread(id: string) {
    const version = ++selectionVersion;
    disconnect();
    error.value = '';
    loading.value = true;
    try {
      const selected = await request(`/threads/${id}`, threadSchema);
      if (version !== selectionVersion) return;
      thread.value = selected;
      workspaceId.value = selected.workspaceId;
      localStorage.setItem('flux-workspace', selected.workspaceId);
      localStorage.setItem('flux-thread', id);
      const run = selected.runs.find((entry) => isRunActive(entry.status));
      if (run) subscribe(run);
    } catch (cause) {
      if (version === selectionVersion) error.value = describeError(cause);
    } finally {
      if (version === selectionVersion) loading.value = false;
    }
  }

  async function newThread(targetWorkspaceId = workspaceId.value) {
    pending.value = true;
    error.value = '';
    try {
      const created = await request('/threads', threadSchema, { workspaceId: targetWorkspaceId });
      await refreshThreads();
      await selectThread(created.id);
      draft.value = '';
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      pending.value = false;
    }
  }

  async function send() {
    const content = draft.value.trim();
    if (
      !content ||
      activeRun.value?.status === 'cancelling' ||
      pending.value ||
      loading.value ||
      !session.value?.configured ||
      (!thread.value && (!workspace.value || workspace.value.archivedAt))
    )
      return;
    pending.value = true;
    error.value = '';
    try {
      const active = activeRun.value;
      // 网络断开后的重试先确认原消息，即使运行已结束也不能误开新一轮。
      const retry =
        steeringAttempt?.content === content && thread.value?.runs.some((run) => run.id === steeringAttempt?.runId);
      if (active || retry) {
        if (!retry) steeringAttempt = { runId: active!.id, content, id: crypto.randomUUID() };
        await request(`/runs/${steeringAttempt!.runId}/steer`, runSchema, { id: steeringAttempt!.id, content });
        steeringAttempt = undefined;
        draft.value = '';
        await refreshThreads();
        return;
      }
      if (!thread.value) thread.value = await request('/threads', threadSchema, { workspaceId: workspaceId.value });
      const run = await request(`/threads/${thread.value.id}/runs`, runSchema, { content });
      draft.value = '';
      steeringAttempt = undefined;
      await refreshThreads();
      await selectThread(run.threadId);
    } catch (cause) {
      if (
        cause instanceof ApiRequestError &&
        ['STEERING_CLOSED', 'STEERING_CONFLICT', 'STEERING_LIMIT'].includes(cause.code)
      )
        steeringAttempt = undefined;
      error.value = describeError(cause);
    } finally {
      pending.value = false;
    }
  }

  async function cancel() {
    if (!activeRun.value) return;
    try {
      await request(`/runs/${activeRun.value.id}/cancel`, runSchema, {});
    } catch (cause) {
      error.value = describeError(cause);
    }
  }

  async function selectWorkspace(id: string) {
    selectionVersion++;
    disconnect();
    thread.value = undefined;
    workspaceId.value = id;
    draft.value = '';
    localStorage.setItem('flux-workspace', id);
    localStorage.removeItem('flux-thread');
    const selected = threads.value[0];
    if (selected) await selectThread(selected.id);
  }

  async function chooseWorkspace(): Promise<void> {
    pending.value = true;
    error.value = '';
    try {
      const { workspace: created } = await request(
        '/workspaces/choose',
        z.object({ workspace: workspaceSchema.nullable() }),
        {},
      );
      if (!created) return;
      workspaces.value = await request('/workspaces', workspaceSchema.array());
      await selectWorkspace(created.id);
    } finally {
      pending.value = false;
    }
  }

  async function renameWorkspace(id: string, name: string): Promise<void> {
    const saved = await request(`/workspaces/${id}/rename`, workspaceSchema, { name });
    workspaces.value = workspaces.value.map((entry) => (entry.id === id ? saved : entry));
  }

  async function renameThread(id: string, title: string): Promise<void> {
    const saved = await request(`/threads/${id}/rename`, threadSchema, { title });
    allThreads.value = allThreads.value.map((entry) => (entry.id === id ? { ...entry, title: saved.title } : entry));
    if (thread.value?.id === id) thread.value.title = saved.title;
  }

  async function deleteThread(id: string): Promise<void> {
    await request(`/threads/${id}/delete`, z.object({ deleted: z.boolean() }), {});
    allThreads.value = allThreads.value.filter((entry) => entry.id !== id);
    if (thread.value?.id === id) {
      steeringAttempt = undefined;
      await selectWorkspace(workspaceId.value);
    }
  }

  async function archiveWorkspace(id: string): Promise<void> {
    pending.value = true;
    try {
      const saved = await request(`/workspaces/${id}/archive`, workspaceSchema, {});
      workspaces.value = workspaces.value.map((entry) => (entry.id === id ? saved : entry));
      allThreads.value = allThreads.value.filter((entry) => entry.workspaceId !== id);
      if (workspaceId.value === id) {
        steeringAttempt = undefined;
        await selectWorkspace(workspaces.value.find((entry) => !entry.archivedAt)?.id ?? '');
      }
    } finally {
      pending.value = false;
    }
  }

  async function setPermission(mode: PermissionMode) {
    if (activeRun.value || pending.value) return;
    pending.value = true;
    error.value = '';
    try {
      if (!thread.value) thread.value = await request('/threads', threadSchema, { workspaceId: workspaceId.value });
      thread.value = await request(`/threads/${thread.value.id}/permission`, threadSchema, {
        mode,
        confirmFullAccess: mode === 'full-access',
      });
      localStorage.setItem('flux-thread', thread.value.id);
      await refreshThreads();
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      pending.value = false;
    }
  }

  async function decideApproval(runId: string, approvalId: string, decision: 'approved' | 'denied') {
    if (approvalPending.value) return;
    approvalPending.value = approvalId;
    error.value = '';
    try {
      await request(`/runs/${runId}/approvals/${approvalId}`, runSchema, { decision });
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      approvalPending.value = '';
    }
  }

  async function saveFeedback(runId: string, input: FeedbackInput): Promise<void> {
    const saved = await request(`/runs/${runId}/feedback`, runSchema, input);
    // 请求期间允许切换会话，只更新仍在展示的对应运行。
    const run = thread.value?.runs.find((entry) => entry.id === saved.id);
    if (run) run.feedback = saved.feedback;
  }

  onMounted(async () => {
    try {
      session.value = await connect();
      await Promise.all([
        refreshThreads(),
        request('/workspaces', workspaceSchema.array()).then((value) => {
          workspaces.value = value;
        }),
      ]);
      const rememberedWorkspace = localStorage.getItem('flux-workspace');
      workspaceId.value =
        workspaces.value.find((entry) => entry.id === rememberedWorkspace)?.id ??
        workspaces.value.find((entry) => !entry.archivedAt)?.id ??
        '';
      const previous = localStorage.getItem('flux-thread');
      const selected = threads.value.find((entry) => entry.id === previous) ?? threads.value[0];
      if (selected) await selectThread(selected.id);
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      loading.value = false;
    }
  });
  onUnmounted(() => {
    selectionVersion++;
    disconnect();
  });

  return {
    session,
    workspaces,
    workspace,
    workspaceId,
    selectWorkspace,
    chooseWorkspace,
    renameWorkspace,
    archiveWorkspace,
    renameThread,
    deleteThread,
    setPermission,
    decideApproval,
    saveFeedback,
    approvalPending,
    allThreads,
    thread,
    draft,
    error,
    connection,
    pending,
    loading,
    activeRun,
    selectThread,
    newThread,
    send,
    cancel,
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : '请求失败，请稍后重试。';
}
