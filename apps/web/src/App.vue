<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { DEFAULT_PERMISSION_MODE, type ModelSettings } from '@flux-agent/contracts';
import AppIcon from './components/AppIcon.vue';
import AssistantRun from './components/AssistantRun.vue';
import AgentWorld from './components/AgentWorld.vue';
import { useChat } from './composables/use-chat';
import ModelSettingsPage from './pages/ModelSettingsPage.vue';
import PermissionSelector from './components/PermissionSelector.vue';
import WorkspaceList from './components/WorkspaceList.vue';
import MemoryPage from './pages/MemoryPage.vue';
import { useFollowScroll } from './composables/use-follow-scroll';
import { useToolInspector } from './composables/use-tool-inspector';
import ToolInspector from './components/ToolInspector.vue';
import type { ToolInspection } from './components/tool-presentation';

const {
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
} = useChat();
type ChatView = 'conversation' | 'trace' | 'world';
function savedView(): ChatView {
  try {
    const value = localStorage.getItem('flux-chat-view');
    if (value === 'trace' || value === 'world') return value;
  } catch {
    // 浏览器禁用本地存储时仍可切换展示方式。
  }
  return 'conversation';
}
const view = ref<ChatView>(savedView());
const conversation = useTemplateRef<HTMLElement>('conversation');
const conversationContent = useTemplateRef<HTMLElement>('conversationContent');
// 场景以角色为阅读起点，不跟随聊天内容自动滚到底部。
const followViewport = computed(() => (view.value === 'world' ? null : conversation.value));
const {
  following: followOutput,
  scrollToLatest,
  pause: pauseFollowing,
  onScroll: trackScroll,
  onWheel,
  onTouchStart,
  onTouchMove,
  onKeydown: onScrollKeydown,
} = useFollowScroll(followViewport, conversationContent);
const inspector = useToolInspector(thread);
const { tabs: inspectorTabs, activeId: inspectorActiveId } = inspector;
let inspectionOpener: HTMLElement | null = null;

function inspectTool(inspection: ToolInspection) {
  inspectionOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pauseFollowing();
  inspector.open(inspection);
}

function previewFile(path: string, line?: number) {
  inspectionOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pauseFollowing();
  inspector.openFile(path, line);
}

function closeInspector(id?: string) {
  if (id) inspector.close(id);
  else inspector.clear();
  if (!inspectorTabs.value.length && inspectionOpener?.isConnected) inspectionOpener.focus({ preventScroll: true });
}
const composerInput = ref<HTMLTextAreaElement>();
const page = ref<'chat' | 'model-settings' | 'memory'>('chat');
const sidebarOpen = ref(window.innerWidth > 760);
const collapsedWorkspaces = ref(new Set<string>());
const turns = computed(
  () =>
    thread.value?.runs.map((run) => ({
      run,
      question:
        thread.value?.messages.find((message) => message.runId === run.id && message.role === 'user')?.content || '',
    })) || [],
);
const stepCount = computed(() => thread.value?.runs.reduce((total, run) => total + run.steps.length, 0) || 0);

watch(
  () => session.value?.configured,
  (configured) => {
    if (configured === false) page.value = 'model-settings';
  },
);

function applyModelSettings(settings: ModelSettings) {
  if (session.value) session.value = { ...session.value, configured: settings.configured, model: settings.model };
  page.value = 'chat';
}

function openThread(id: string) {
  page.value = session.value?.configured ? 'chat' : 'model-settings';
  if (window.innerWidth <= 760) sidebarOpen.value = false;
  void selectThread(id);
}

function openSettings() {
  page.value = 'model-settings';
  if (window.innerWidth <= 760) sidebarOpen.value = false;
}

function openMemory() {
  page.value = 'memory';
  if (window.innerWidth <= 760) sidebarOpen.value = false;
}

function openNewThread(id = workspaceId.value) {
  collapsedWorkspaces.value.delete(id);
  page.value = 'chat';
  view.value = 'conversation';
  if (window.innerWidth <= 760) sidebarOpen.value = false;
  void newThread(id);
}

watch(
  () => thread.value?.id,
  async () => {
    if (view.value !== 'world') return scrollToLatest();
    pauseFollowing();
    await nextTick();
    conversation.value?.scrollTo({ top: 0 });
  },
);
watch(workspaceId, () => {
  collapsedWorkspaces.value.delete(workspaceId.value);
});
watch(view, async (selected) => {
  try {
    localStorage.setItem('flux-chat-view', selected);
  } catch {
    // 展示偏好不影响任务执行。
  }
  if (selected === 'conversation') return scrollToLatest();
  pauseFollowing();
  await nextTick();
  conversation.value?.scrollTo({ top: 0 });
});
watch(draft, async () => {
  await nextTick();
  if (!composerInput.value) return;
  composerInput.value.style.height = 'auto';
  composerInput.value.style.height = `${Math.min(composerInput.value.scrollHeight, 160)}px`;
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

function onConversationClick(event: MouseEvent) {
  // 展开历史内容是在主动阅读，保留当前行的位置。
  if (event.target instanceof Element && event.target.closest('summary')) pauseFollowing();
}

function suggest(content: string) {
  draft.value = content;
  composerInput.value?.focus();
}

function toggleWorkspace(id: string) {
  if (collapsedWorkspaces.value.has(id)) collapsedWorkspaces.value.delete(id);
  else collapsedWorkspaces.value.add(id);
}
</script>

<template>
  <div class="workspace" :class="{ 'sidebar-collapsed': !sidebarOpen }">
    <button v-if="sidebarOpen" class="sidebar-overlay" aria-label="关闭侧栏" @click="sidebarOpen = false" />
    <aside v-if="sidebarOpen" class="sidebar" aria-label="工作台侧栏">
      <div class="brand-row">
        <a class="brand" href="#" aria-label="Flux 首页" @click.prevent="page = 'chat'">
          <span class="brand-symbol"><AppIcon name="spark" :size="25" /></span><span>flux</span
          ><span class="brand-label">AGENT</span>
        </a>
        <button class="icon-button" aria-label="收起侧栏" @click="sidebarOpen = false">
          <AppIcon name="sidebar" />
        </button>
      </div>
      <button
        class="new-chat"
        :disabled="pending || loading || !session?.configured || !workspace || !!workspace.archivedAt"
        @click="openNewThread()"
      >
        <AppIcon name="plus" :size="17" />新建对话
      </button>
      <WorkspaceList
        :workspaces="workspaces"
        :threads="allThreads"
        :selected="workspaceId"
        :selected-thread="page === 'chat' ? thread?.id : undefined"
        :disabled="pending || loading"
        :choose="chooseWorkspace"
        :rename="renameWorkspace"
        :archive="archiveWorkspace"
        :rename-thread="renameThread"
        :delete-thread="deleteThread"
        :collapsed="collapsedWorkspaces"
        @select="selectWorkspace"
        @toggle="toggleWorkspace"
        @thread="openThread"
        @create="openNewThread"
      />
      <div class="sidebar-bottom">
        <button
          class="settings-navigation"
          :class="{ selected: page === 'memory' }"
          :disabled="!workspace || pending"
          @click="openMemory"
        >
          <AppIcon name="memory" />长期记忆<AppIcon class="settings-arrow" name="chevron" :size="14" />
        </button>
        <button
          class="settings-navigation"
          :class="{ selected: page === 'model-settings' }"
          :disabled="!session || pending"
          @click="openSettings"
        >
          <AppIcon name="settings" />模型设置<AppIcon class="settings-arrow" name="chevron" :size="14" />
        </button>
        <div class="storage-note">
          <span class="status-dot" />本地运行<span>·</span
          >{{ session?.storage === 'sqlite' ? 'SQLite 已持久化' : '临时会话' }}
        </div>
      </div>
    </aside>

    <div class="workbench" :class="{ 'has-inspector': page === 'chat' && inspectorTabs.length }">
      <main>
        <header class="topbar">
          <div class="header-row">
            <button v-if="!sidebarOpen" class="icon-button" aria-label="展开侧栏" @click="sidebarOpen = true">
              <AppIcon name="sidebar" />
            </button>
            <h1>
              {{ page === 'model-settings' ? '模型设置' : page === 'memory' ? '长期记忆' : thread?.title || '新对话' }}
            </h1>
            <span class="workspace-mode"
              ><span class="status-dot" :class="{ offline: !session?.configured }" />{{
                session?.configured ? '标准模式' : '等待配置'
              }}</span
            >
            <button
              class="icon-button header-settings"
              aria-label="打开模型设置"
              :disabled="!session"
              @click="page = page === 'model-settings' ? 'chat' : 'model-settings'"
            >
              <AppIcon :name="page === 'model-settings' ? 'chat' : 'settings'" />
            </button>
          </div>
          <div v-if="page === 'chat'" class="view-tabs" role="tablist" aria-label="对话视图">
            <button
              id="conversation-tab"
              role="tab"
              :aria-selected="view === 'conversation'"
              aria-controls="conversation-panel"
              :class="{ active: view === 'conversation' }"
              @click="view = 'conversation'"
            >
              对话
            </button>
            <button
              id="trace-tab"
              role="tab"
              :aria-selected="view === 'trace'"
              aria-controls="trace-panel"
              :class="{ active: view === 'trace' }"
              @click="view = 'trace'"
            >
              轨迹<span v-if="stepCount" class="tab-count">{{ stepCount }}</span>
            </button>
            <button
              id="world-tab"
              role="tab"
              :aria-selected="view === 'world'"
              aria-controls="world-panel"
              :class="{ active: view === 'world' }"
              @click="view = 'world'"
            >
              <AppIcon name="agents" :size="15" />协作空间
            </button>
          </div>
        </header>

        <ModelSettingsPage
          v-if="session && page === 'model-settings'"
          @saved="applyModelSettings"
          @back="page = 'chat'"
        />
        <MemoryPage
          v-else-if="page === 'memory' && workspace"
          :key="workspace.id"
          :workspace-id="workspace.id"
          :workspace-name="workspace.name"
          @source="openThread"
          @back="page = 'chat'"
        />
        <template v-else>
          <section
            :id="`${view}-panel`"
            ref="conversation"
            class="conversation"
            role="tabpanel"
            tabindex="0"
            :aria-labelledby="`${view}-tab`"
            :aria-busy="loading"
            @scroll="trackScroll"
            @wheel.passive="onWheel"
            @touchstart.passive="onTouchStart"
            @touchmove.passive="onTouchMove"
            @keydown="onScrollKeydown"
            @click="onConversationClick"
          >
            <AgentWorld
              v-if="view === 'world'"
              :turns="turns"
              :approval-pending="approvalPending"
              @decide="decideApproval"
              @inspect="inspectTool"
              @open-file="previewFile"
            />
            <div v-else-if="!turns.length && view === 'conversation'" class="welcome">
              <div class="welcome-brand"><AppIcon name="spark" :size="38" /><span>flux</span></div>
              <h2>有什么想一起探索的？</h2>
              <p :title="workspace?.rootPath">从一个问题开始，也可以一起探索 {{ workspace?.name || '你的工作区' }}。</p>
              <div class="suggestions">
                <button @click="suggest('帮我查询一下当前的日期和时间。')">
                  <AppIcon name="clock" />查一查当前时间<AppIcon name="chevron" :size="14" />
                </button>
                <button @click="suggest('用一个简单例子解释 TypeScript 的联合类型。')">
                  <AppIcon name="code" />理解一个概念<AppIcon name="chevron" :size="14" />
                </button>
                <button @click="suggest('帮我把一个想法拆成可执行的小步骤。请先问我想做什么。')">
                  <AppIcon name="thought" />拆解一个想法<AppIcon name="chevron" :size="14" />
                </button>
              </div>
            </div>
            <div v-else-if="!turns.length" class="empty-trace">
              <AppIcon name="trace" :size="32" />
              <h2>每一步，都有迹可循</h2>
              <p>发送消息后，在这里查看模型返回的思考与工具执行过程。</p>
            </div>
            <div v-else ref="conversationContent" class="messages" :class="{ 'trace-messages': view === 'trace' }">
              <div v-if="view === 'trace'" class="trace-heading">
                <span class="eyebrow">EXECUTION TRACE</span>
                <h2>执行轨迹</h2>
                <p>{{ turns.length }} 轮对话 · {{ stepCount }} 个步骤</p>
              </div>
              <article v-for="(turn, index) in turns" :key="turn.run.id" class="conversation-turn">
                <div v-if="view === 'trace'" class="trace-question">
                  <span class="turn-number">{{ String(index + 1).padStart(2, '0') }}</span
                  ><span>{{ turn.question }}</span>
                </div>
                <div v-else class="user-message">
                  <div class="user-text">{{ turn.question }}</div>
                </div>
                <AssistantRun
                  :key="`${turn.run.id}-${view}`"
                  :run="turn.run"
                  :trace="view === 'trace'"
                  :approval-pending="approvalPending"
                  :save-feedback="(input) => saveFeedback(turn.run.id, input)"
                  @decide="(id, decision) => decideApproval(turn.run.id, id, decision)"
                  @inspect="inspectTool"
                  @open-file="previewFile"
                />
              </article>
            </div>
          </section>

          <footer class="composer-area">
            <button
              v-if="view !== 'world' && !followOutput && turns.length"
              class="jump-latest icon-button"
              aria-label="回到最新消息"
              @click="scrollToLatest"
            >
              <AppIcon name="down" />
            </button>
            <p v-if="error" class="error-banner" role="alert">
              {{ error
              }}<button class="icon-button" aria-label="关闭错误提示" @click="error = ''">
                <AppIcon name="close" :size="14" />
              </button>
            </p>
            <p v-if="connection" class="connection-note" role="status">{{ connection }}</p>
            <form class="composer" @submit.prevent="send">
              <textarea
                ref="composerInput"
                v-model="draft"
                aria-label="消息"
                :placeholder="activeRun ? '补充要求，调整当前任务的方向…' : '发送消息，开始探索…'"
                rows="1"
                maxlength="32000"
                :disabled="!session?.configured || pending || loading"
                @keydown="onKeydown"
              />
              <div class="composer-actions">
                <PermissionSelector
                  :mode="thread?.permissionMode ?? DEFAULT_PERMISSION_MODE"
                  :disabled="!!activeRun || pending || loading || !session"
                  @change="setPermission"
                />
                <button class="model-selector" type="button" :disabled="!session" @click="page = 'model-settings'">
                  <span>{{ session?.model || '配置模型' }}</span
                  ><AppIcon name="down" :size="13" />
                </button>
                <button
                  v-if="activeRun"
                  class="send-button stop-button"
                  type="button"
                  :aria-label="activeRun.status === 'cancelling' ? '正在停止' : '停止生成'"
                  :title="activeRun.status === 'cancelling' ? '正在停止' : '停止生成'"
                  :disabled="activeRun.status === 'cancelling'"
                  @click="cancel"
                >
                  <AppIcon name="stop" :size="18" />
                </button>
                <button
                  class="send-button"
                  type="submit"
                  :aria-label="activeRun ? '调整方向' : '发送'"
                  :title="activeRun ? '调整方向：完成当前最小执行单元后优先处理新消息' : '发送'"
                  :disabled="
                    !draft.trim() ||
                    !session?.configured ||
                    pending ||
                    loading ||
                    activeRun?.status === 'cancelling' ||
                    (!thread && (!workspace || !!workspace.archivedAt))
                  "
                >
                  <AppIcon name="arrow" :size="20" />
                </button>
              </div>
            </form>
            <div class="composer-footnote">
              <span>{{
                activeRun ? '调整方向：当前工具完成后切换，生成中的回答立即切换' : 'Flux 可能会出错，请核实重要信息'
              }}</span
              ><span class="keyboard-hint">· Shift + Enter 换行</span>
            </div>
          </footer>
        </template>
      </main>
      <ToolInspector
        v-if="page === 'chat' && inspectorTabs.length"
        :tabs="inspectorTabs"
        :active-id="inspectorActiveId"
        :workspace-path="workspace?.rootPath || ''"
        @select="inspectorActiveId = $event"
        @close="closeInspector"
        @clear="closeInspector()"
        @refresh="inspector.refresh"
      />
    </div>
  </div>
</template>
