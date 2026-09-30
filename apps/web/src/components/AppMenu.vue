<script setup lang="ts">
import { ref, useId } from 'vue';
import AppIcon from './AppIcon.vue';

defineProps<{ label: string; disabled?: boolean; triggerClass?: string }>();
const menuId = useId();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const opened = ref(false);

function place(event: ToggleEvent) {
  if (event.newState !== 'open') return;
  const rect = trigger.value!.getBoundingClientRect();
  const popup = menu.value!;
  // 在弹出层显示前测量和定位，避免第一帧落到屏幕左上角。
  popup.style.display = 'block';
  const height = popup.offsetHeight;
  const width = popup.offsetWidth;
  popup.style.removeProperty('display');
  popup.style.left = `${Math.max(12, rect.right - width)}px`;
  popup.style.top = `${rect.bottom + height + 12 > innerHeight ? Math.max(12, rect.top - height - 6) : rect.bottom + 6}px`;
}

function dismiss(event: MouseEvent) {
  if ((event.target as Element).closest('button:not(:disabled)')) menu.value?.hidePopover();
}
</script>

<template>
  <div class="app-menu-anchor">
    <button
      ref="trigger"
      :class="triggerClass || 'icon-button capability-more'"
      :aria-label="label"
      :title="label"
      :popovertarget="menuId"
      :aria-expanded="opened"
      :disabled="disabled"
    >
      <slot name="trigger"><AppIcon name="more" :size="21" /></slot>
    </button>
    <div
      :id="menuId"
      ref="menu"
      popover
      class="app-menu"
      :aria-label="label"
      @beforetoggle="place($event as ToggleEvent)"
      @toggle="opened = ($event as ToggleEvent).newState === 'open'"
      @click.capture="dismiss"
    >
      <slot />
    </div>
  </div>
</template>
