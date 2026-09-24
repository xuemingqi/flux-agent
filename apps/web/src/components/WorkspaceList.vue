<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ThreadSummary, Workspace } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';
import WorkspaceActions from './WorkspaceActions.vue';
import ThreadActions from './ThreadActions.vue';
const props = defineProps<{
  workspaces: Workspace[];
  threads: ThreadSummary[];
  selected: string;
  selectedThread?: string;
  disabled: boolean;
  collapsed: Set<string>;
  choose: () => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  renameThread: (id: string, title: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
}>();
defineEmits<{ select: [id: string]; thread: [id: string]; toggle: [id: string]; create: [id: string] }>();
const choosing = ref(false);
const error = ref('');
const groups = computed(() => {
  const active = props.workspaces.filter((workspace) => !workspace.archivedAt);
  const grouped = active.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    workspace: workspace as Workspace | null,
    threads: props.threads.filter((thread) => thread.workspaceId === workspace.id),
  }));
  const ungrouped = props.threads.filter((thread) => !active.some((workspace) => workspace.id === thread.workspaceId));
  if (ungrouped.length) grouped.push({ id: 'ungrouped', name: '未分组', workspace: null, threads: ungrouped });
  return grouped;
});

function dateLabel(value: string): string {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? '今天' : `${date.getMonth() + 1}/${date.getDate()}`;
}

async function chooseDirectory() {
  if (choosing.value) return;
  choosing.value = true;
  error.value = '';
  try {
    await props.choose();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法打开目录选择器，请重试。';
  } finally {
    choosing.value = false;
  }
}
</script>
<template>
  <div class="section-label workspace-list-heading">
    工作区<span>本地</span>
    <button
      class="icon-button"
      :disabled="disabled || choosing"
      aria-label="添加工作区"
      title="选择本地目录"
      @click="chooseDirectory"
    >
      <AppIcon name="plus" :size="16" />
    </button>
  </div>
  <p v-if="choosing" class="workspace-picker-note" role="status">请在系统窗口中选择目录…</p>
  <p v-if="error" class="workspace-picker-note error-text" role="alert">{{ error }}</p>
  <div class="workspace-groups" aria-label="工作区列表">
    <section
      v-for="group in groups"
      :key="group.id"
      class="workspace-group"
      :aria-label="`工作区 ${group.name}`"
      :data-workspace-id="group.id"
    >
      <div class="workspace-group-heading" :class="{ current: selected === group.id }">
        <button
          class="icon-button workspace-disclosure"
          :aria-label="collapsed.has(group.id) ? '展开工作区会话' : '折叠工作区会话'"
          :aria-expanded="!collapsed.has(group.id)"
          :aria-controls="`workspace-threads-${group.id}`"
          @click="$emit('toggle', group.id)"
        >
          <AppIcon :name="collapsed.has(group.id) ? 'chevron' : 'down'" :size="15" />
        </button>
        <button
          v-if="group.workspace"
          class="workspace-select"
          :disabled="disabled"
          :aria-pressed="selected === group.id"
          :title="group.workspace.rootPath"
          @click="$emit('select', group.id)"
        >
          <AppIcon name="folder" :size="17" /><span>{{ group.workspace.name }}</span>
        </button>
        <span v-else class="workspace-ungrouped">未分组</span>
        <WorkspaceActions
          v-if="group.workspace"
          :workspace="group.workspace"
          :disabled="disabled"
          :rename="rename"
          :archive="archive"
          @create="$emit('create', group.id)"
        />
      </div>
      <nav
        :id="`workspace-threads-${group.id}`"
        v-show="!collapsed.has(group.id)"
        class="thread-list"
        aria-label="对话记录"
      >
        <div
          v-for="item in group.threads"
          :key="item.id"
          class="thread-row"
          :class="{ selected: selectedThread === item.id }"
        >
          <button
            class="thread-select"
            :aria-current="selectedThread === item.id ? 'page' : undefined"
            :disabled="disabled"
            @click="$emit('thread', item.id)"
          >
            <AppIcon name="chat" :size="15" /><span class="thread-title">{{ item.title }}</span
            ><span class="thread-date">{{ dateLabel(item.updatedAt) }}</span>
          </button>
          <ThreadActions :thread="item" :disabled="disabled" :rename="renameThread" :remove="deleteThread" />
        </div>
        <p v-if="!group.threads.length" class="empty-history">你的对话会出现在这里</p>
      </nav>
    </section>
  </div>
</template>
