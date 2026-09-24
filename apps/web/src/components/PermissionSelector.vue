<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { permissionLabels, type PermissionMode } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';

defineProps<{ mode: PermissionMode; disabled: boolean }>();
const emit = defineEmits<{ change: [mode: PermissionMode] }>();
const open = ref(false);
const container = ref<HTMLElement>();
const confirmation = ref<HTMLDialogElement>();
const descriptions: Record<PermissionMode, string> = {
  'read-only': '读取与搜索工作区，不修改文件',
  'workspace-write': '工作区内写入，每次修改前确认',
  'full-access': '本机文件和命令，无逐次审批',
};
function choose(mode: PermissionMode) {
  open.value = false;
  if (mode === 'full-access') confirmation.value?.showModal();
  else emit('change', mode);
}
function confirm() {
  confirmation.value?.close();
  emit('change', 'full-access');
}
function outside(event: PointerEvent) {
  if (!container.value?.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onUnmounted(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="container" class="permission-selector" @keydown.esc="open = false">
    <button
      class="permission-trigger"
      type="button"
      aria-label="运行权限"
      :aria-expanded="open"
      :disabled="disabled"
      @click="open = !open"
    >
      <AppIcon :name="mode === 'full-access' ? 'terminal' : 'shield'" :size="15" />
      <span>{{ permissionLabels[mode] }}</span
      ><AppIcon name="down" :size="12" />
    </button>
    <div v-if="open" class="permission-menu" aria-label="权限级别">
      <button
        v-for="(label, value) in permissionLabels"
        :key="value"
        type="button"
        :aria-pressed="mode === value"
        @click="choose(value)"
      >
        <span
          ><strong>{{ label }}</strong
          ><small>{{ descriptions[value] }}</small></span
        >
        <AppIcon v-if="mode === value" name="check" :size="16" />
      </button>
    </div>
  </div>
  <dialog ref="confirmation" class="flux-dialog" aria-labelledby="permission-title">
    <h2 id="permission-title">开启完全权限？</h2>
    <p>此对话中的 Agent 将能够读写工作区外的文件，并在你的电脑上执行命令和访问网络，操作前不再逐次询问。</p>
    <p>命令直接在本机运行，没有容器隔离。只在你信任当前任务和文件内容时开启。</p>
    <div class="dialog-actions">
      <button type="button" @click="confirmation?.close()">取消</button
      ><button type="button" class="primary-action" @click="confirm">确认开启完全权限</button>
    </div>
  </dialog>
</template>
