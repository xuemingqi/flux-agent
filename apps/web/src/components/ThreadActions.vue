<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { ThreadSummary } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  thread: ThreadSummary;
  disabled: boolean;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}>();
const container = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const dialog = ref<HTMLDialogElement>();
const open = ref(false);
const position = ref({ left: '0px', top: '0px' });
const action = ref<'rename' | 'delete'>('rename');
const title = ref('');
const busy = ref(false);
const error = ref('');

function toggle() {
  const rect = trigger.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, rect.right - 160)}px`,
    top: `${Math.min(rect.bottom + 5, innerHeight - 96)}px`,
  };
  open.value = !open.value;
}
function choose(value: 'rename' | 'delete') {
  open.value = false;
  action.value = value;
  title.value = props.thread.title;
  error.value = '';
  dialog.value?.showModal();
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (action.value === 'rename') await props.rename(props.thread.id, title.value.trim());
    else await props.remove(props.thread.id);
    dialog.value?.close();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '会话更新失败，请重试。';
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
  <div ref="container" class="thread-actions" :class="{ open }" @keydown.esc="open = false">
    <button
      ref="trigger"
      class="icon-button"
      :aria-label="`会话“${thread.title}”的操作`"
      title="更多操作"
      :aria-expanded="open"
      :disabled="disabled"
      @click="toggle"
    >
      <AppIcon name="more" :size="15" />
    </button>
    <div v-if="open" class="workspace-action-menu" :style="position" aria-label="会话操作">
      <button @click="choose('rename')"><AppIcon name="edit" :size="15" />重命名</button>
      <button @click="choose('delete')"><AppIcon name="close" :size="15" />删除会话</button>
    </div>
    <dialog
      ref="dialog"
      class="flux-dialog"
      :aria-label="action === 'rename' ? '重命名会话' : '删除会话'"
      @cancel="busy && $event.preventDefault()"
      @close="trigger?.focus()"
    >
      <form @submit.prevent="submit">
        <h2>{{ action === 'rename' ? '重命名会话' : '删除会话' }}</h2>
        <label v-if="action === 'rename'"
          >会话名称<input v-model="title" aria-label="会话名称" maxlength="100" required :disabled="busy"
        /></label>
        <p v-else>将永久删除“{{ thread.title }}”及其消息和执行记录。项目文件和长期记忆保留。</p>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="dialog?.close()">取消</button>
          <button class="primary-action" :disabled="busy || (action === 'rename' && !title.trim())">
            {{ busy ? '保存中…' : action === 'rename' ? '保存名称' : '确认删除' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
