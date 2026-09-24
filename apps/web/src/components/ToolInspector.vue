<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import type { InspectorTab } from '../composables/use-tool-inspector';
import { parseToolObject } from './tool-presentation';
import AppIcon from './AppIcon.vue';
import FileContent from './FileContent.vue';
import MessageContent from './MessageContent.vue';

const props = defineProps<{ tabs: InspectorTab[]; activeId: string; workspacePath: string }>();
defineEmits<{
  select: [id: string];
  close: [id: string];
  clear: [];
  refresh: [];
}>();
const active = computed(() => props.tabs.find((tab) => tab.id === props.activeId));
const step = computed(() => active.value?.inspection?.step);
const input = computed(() => parseToolObject(step.value?.input || ''));
const approval = computed(() => active.value?.inspection?.approval);
const expanded = ref(false);
const source = ref(false);
const copyStatus = ref('');
const body = useTemplateRef<HTMLElement>('body');
const closeButton = useTemplateRef<HTMLButtonElement>('closeButton');
const isMarkdown = computed(() => /\.(md|markdown)$/i.test(active.value?.file?.path || ''));
const filePath = computed(() => {
  const path = active.value?.file?.path || String(input.value.path || '');
  return path.startsWith('/') ? path : `${props.workspacePath}/${path}`;
});
const sourceLabel = computed(
  () =>
    ({ read: '读取时的内容', write: approval.value ? '本次申请的修改' : '本次写入内容', current: '当前文件' })[
      active.value?.source || 'current'
    ],
);
async function copyContent() {
  try {
    await navigator.clipboard.writeText(active.value?.file?.content ?? step.value?.output ?? '');
    copyStatus.value = '已复制';
  } catch {
    copyStatus.value = '复制失败，请手动选择内容';
  }
}

watch(
  () => props.activeId,
  () => {
    source.value = !!active.value?.line;
    copyStatus.value = '';
    if (body.value) body.value.scrollTop = 0;
  },
  { immediate: true },
);
watch(
  () => [active.value?.file, active.value?.line, source.value],
  async () => {
    await nextTick();
    const container = body.value;
    const line = container?.querySelector(`[data-line="${active.value?.line}"]`);
    if (container && line)
      container.scrollTop +=
        line.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2;
  },
  { flush: 'post' },
);
watch(closeButton, (button) => button?.focus(), { flush: 'post' });
</script>

<template>
  <aside
    v-if="active"
    class="tool-inspector"
    :class="{ expanded }"
    aria-label="文件预览"
    @keydown.esc.stop="$emit('clear')"
  >
    <header class="inspector-header">
      <div class="inspector-tabs" role="tablist" aria-label="打开的文件">
        <div v-for="tab in tabs" :key="tab.id" class="inspector-tab" :class="{ selected: tab.id === activeId }">
          <button
            role="tab"
            :aria-selected="tab.id === activeId"
            @click="$emit('select', tab.id)"
            :title="tab.file?.path || tab.title"
          >
            <AppIcon name="file" :size="14" /><span>{{ tab.title }}</span>
          </button>
          <button class="icon-button" :aria-label="`关闭 ${tab.title}`" @click="$emit('close', tab.id)">
            <AppIcon name="close" :size="12" />
          </button>
        </div>
      </div>
      <button
        class="icon-button inspector-expand"
        :aria-label="expanded ? '恢复分屏' : '展开预览'"
        @click="expanded = !expanded"
      >
        <AppIcon :name="expanded ? 'open-panel' : 'expand'" :size="15" />
      </button>
      <button ref="closeButton" class="icon-button" aria-label="关闭预览" @click="$emit('clear')">
        <AppIcon name="close" :size="17" />
      </button>
    </header>
    <div class="inspector-toolbar">
      <span class="inspector-path" :title="active.file ? filePath : String(input.path || active.title)">{{
        active.file ? filePath : input.path || active.title
      }}</span>
      <button v-if="active.file && isMarkdown" class="inspector-text-button" @click="source = !source">
        {{ source ? 'Markdown 预览' : '查看源码' }}
      </button>
      <button
        v-if="active.file"
        class="icon-button"
        aria-label="读取当前文件"
        :disabled="active.loading"
        @click="$emit('refresh')"
      >
        <AppIcon name="refresh" :size="15" />
      </button>
      <button class="icon-button" aria-label="复制预览内容" @click="copyContent">
        <AppIcon name="copy" :size="14" />
      </button>
    </div>
    <div class="inspector-meta">
      <span v-if="active.loading" role="status"><span class="spinner" />正在读取…</span>
      <span v-else-if="active.file">{{ sourceLabel }}</span>
      <span v-if="copyStatus" role="status">{{ copyStatus }}</span>
    </div>
    <div ref="body" class="inspector-body" role="tabpanel" :aria-label="active.title" tabindex="0">
      <p v-if="active.error" class="inspector-error" role="alert">{{ active.error }}</p>
      <template v-if="active.file && !active.loading">
        <div v-if="active.source === 'write' && approval" class="file-change-comparison">
          <section>
            <h3>修改前{{ approval.before === null ? ' · 新文件' : '' }}</h3>
            <FileContent :content="approval.before ?? '（不存在）'" />
          </section>
          <section>
            <h3>修改后</h3>
            <FileContent :content="active.file.content" />
          </section>
        </div>
        <MessageContent v-else-if="isMarkdown && !source" class="file-markdown" :content="active.file.content" />
        <FileContent v-else :content="active.file.content" :highlighted-line="active.line" />
      </template>
    </div>
  </aside>
</template>
