<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { Workspace } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  workspace: Workspace;
  disabled: boolean;
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
}>();
defineEmits<{ create: [] }>();
const container = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const dialog = ref<HTMLDialogElement>();
const open = ref(false);
const menuPosition = ref({ left: '0px', top: '0px' });
const action = ref<'rename' | 'archive'>('rename');
const name = ref('');
const busy = ref(false);
const error = ref('');

function toggleMenu() {
  const rect = trigger.value!.getBoundingClientRect();
  menuPosition.value = {
    left: `${Math.max(8, rect.right - 160)}px`,
    top: `${Math.min(rect.bottom + 5, window.innerHeight - 96)}px`,
  };
  open.value = !open.value;
}

function choose(value: 'rename' | 'archive') {
  open.value = false;
  action.value = value;
  name.value = props.workspace.name;
  error.value = '';
  dialog.value?.showModal();
}

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (action.value === 'rename') await props.rename(props.workspace.id, name.value.trim());
    else await props.archive(props.workspace.id);
    dialog.value?.close();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '工作区更新失败，请重试。';
  } finally {
    busy.value = false;
  }
}

function outside(event: PointerEvent) {
  if (!container.value?.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onUnmounted(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="container" class="workspace-actions" :class="{ open }" @keydown.esc="open = false">
    <button
      ref="trigger"
      class="icon-button"
      :aria-label="`工作区“${workspace.name}”的操作`"
      title="更多操作"
      :aria-expanded="open"
      :disabled="disabled"
      @click="toggleMenu"
    >
      <AppIcon name="more" :size="15" />
    </button>
    <button
      class="icon-button"
      :aria-label="`在“${workspace.name}”中新建会话`"
      title="新建会话"
      :disabled="disabled"
      @click="$emit('create')"
    >
      <AppIcon name="plus" :size="16" />
    </button>
    <div v-if="open" class="workspace-action-menu" :style="menuPosition" aria-label="工作区操作">
      <button @click="choose('rename')"><AppIcon name="edit" :size="15" />重命名</button>
      <button @click="choose('archive')"><AppIcon name="close" :size="15" />移除工作区</button>
    </div>
    <dialog
      ref="dialog"
      class="flux-dialog"
      :aria-label="action === 'rename' ? '重命名工作区' : '移除工作区'"
      @cancel="busy && $event.preventDefault()"
      @close="trigger?.focus()"
    >
      <form @submit.prevent="submit">
        <h2>{{ action === 'rename' ? '重命名工作区' : '移除工作区' }}</h2>
        <label v-if="action === 'rename'"
          >工作区名称<input v-model="name" aria-label="工作区名称" maxlength="100" required :disabled="busy"
        /></label>
        <p v-else>
          将把“{{
            workspace.name
          }}”从工作区列表移除，并永久删除其中的全部会话、消息及运行记录。项目文件和长期记忆保留，重新添加目录不会恢复已删除的会话。
        </p>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="dialog?.close()">取消</button>
          <button class="primary-action" :disabled="busy || (action === 'rename' && !name.trim())">
            {{ busy ? '保存中…' : action === 'rename' ? '保存名称' : '确认移除' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
