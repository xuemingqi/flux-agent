<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import type { RunStep } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';
import MessageContent from './MessageContent.vue';
import ToolResult from './ToolResult.vue';
import { useFollowScroll } from '../composables/use-follow-scroll';
import { toolPresentation, toolTarget, toolStatus, type ToolStep } from './tool-presentation';

const props = defineProps<{ step: RunStep; expanded?: boolean }>();
defineEmits<{ inspect: [step: ToolStep]; openFile: [path: string, line?: number] }>();
const copyStatus = ref('');
const logViewport = useTemplateRef<HTMLElement>('logViewport');
const logContent = useTemplateRef<HTMLElement>('logContent');
const {
  following: followLog,
  scrollToLatest: latestLog,
  onScroll: onLogScroll,
  onWheel: onLogWheel,
  onTouchStart: onLogTouchStart,
  onTouchMove: onLogTouchMove,
  onKeydown: onLogKeydown,
} = useFollowScroll(logViewport, logContent);
const target = computed(() => (props.step.kind === 'tool' ? toolTarget(props.step) : ''));

const reasoningPreview = computed(() =>
  props.step.kind === 'reasoning' ? props.step.content.slice(-320).replace(/\s+/g, ' ').trim() : '',
);
const progress = computed(() => (props.step.kind === 'tool' ? props.step.progress.join('\n') : ''));
const commandResult = computed<Record<string, unknown> | undefined>(() => {
  if (props.step.kind !== 'tool' || props.step.name !== 'run_command') return;
  try {
    const result = JSON.parse(props.step.output);
    if (result && typeof result.output === 'string') return result;
  } catch {
    // 工具异常可能是纯文本，交由下方日志原样展示。
  }
});
const output = computed(() => {
  if (props.step.kind !== 'tool') return '';
  if (commandResult.value) return String(commandResult.value.output);
  return pretty(props.step.output);
});
const logText = computed(() =>
  props.step.kind === 'tool' && props.step.status === 'running' ? progress.value : output.value,
);

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copyStatus.value = '已复制';
  } catch {
    copyStatus.value = '复制失败，请手动选择内容';
  }
}
</script>

<template>
  <div v-if="step.kind === 'text'" class="response-text"><MessageContent :content="step.content" /></div>
  <div v-else-if="step.kind === 'steering'" class="steering-message" aria-label="已纳入上下文的补充消息">
    <span class="steering-label">调整方向 · 已开始处理</span>
    <div class="user-text">{{ step.content }}</div>
  </div>
  <details v-else-if="step.kind === 'reasoning'" class="process-step reasoning-step" :open="expanded">
    <summary>
      <AppIcon name="thought" />
      <span class="step-name">思考</span><span class="step-divider">·</span>
      <span class="step-preview reasoning-preview"
        ><span>{{ reasoningPreview }}</span></span
      >
      <AppIcon class="disclosure" name="chevron" :size="14" />
    </summary>
    <div class="reasoning-content">{{ step.content }}</div>
  </details>
  <button
    v-else-if="
      step.kind === 'tool' &&
      ['read_file', 'write_file'].includes(step.name) &&
      ['running', 'succeeded'].includes(step.status)
    "
    class="process-step tool-step tool-event"
    :class="step.status"
    :data-tool="step.name"
    :title="step.name"
    :disabled="step.status === 'running'"
    @click="$emit('inspect', step)"
  >
    <span v-if="step.status === 'running'" class="spinner" />
    <AppIcon v-else :name="step.status === 'failed' ? 'close' : toolPresentation(step.name).icon" />
    <span class="step-name">{{ toolPresentation(step.name).label }}</span>
    <span v-if="target" class="step-divider">·</span>
    <span
      class="step-preview"
      :class="{ 'file-target': ['read_file', 'write_file'].includes(step.name) }"
      :title="target"
      >{{ target }}</span
    >
    <span class="step-status" :class="step.status">{{ toolStatus(step) }}</span>
    <AppIcon class="disclosure" name="open-panel" :size="14" />
  </button>
  <details
    v-else-if="step.name === 'run_command'"
    class="process-step tool-step"
    :class="step.status"
    :data-tool="step.name"
    :open="expanded"
  >
    <summary>
      <span v-if="step.status === 'running'" class="spinner" />
      <AppIcon v-else :name="step.status === 'failed' ? 'close' : 'terminal'" />
      <span class="step-name">Bash</span>
      <span v-if="target" class="step-divider">·</span>
      <span class="step-preview" :title="target">{{ target }}</span>
      <span class="step-status" :class="step.status">{{ toolStatus(step) }}</span>
      <AppIcon class="disclosure" name="chevron" :size="14" />
    </summary>
    <div class="tool-detail">
      <div class="tool-command-bar">
        <span class="status-dot" :class="step.status" />
        <code :title="target">{{ target || step.name }}</code>
        <button class="icon-button" aria-label="复制命令" @click="copy(target)">
          <AppIcon name="copy" :size="14" />
        </button>
      </div>
      <div class="tool-log-area">
        <pre
          v-if="logText"
          ref="logViewport"
          class="tool-log"
          :class="{ 'error-text': step.status === 'failed' }"
          tabindex="0"
          :aria-label="`${step.name} ${step.status === 'running' ? '实时输出' : '执行结果'}`"
          @scroll="onLogScroll"
          @wheel.stop.passive="onLogWheel"
          @touchstart.stop.passive="onLogTouchStart"
          @touchmove.stop.passive="onLogTouchMove"
          @keydown.stop="onLogKeydown"
        ><code ref="logContent">{{ logText }}</code></pre>
        <p v-else class="tool-waiting">{{ step.status === 'running' ? '等待工具输出…' : '工具未返回文本输出。' }}</p>
        <button v-if="!followLog && logText" class="tool-log-latest" @click="latestLog">
          <AppIcon name="down" :size="12" />最新输出
        </button>
      </div>
      <div class="tool-result-bar">
        <span>{{ toolStatus(step) }}</span>
        <span v-if="typeof commandResult?.exitCode === 'number'">退出码 {{ commandResult.exitCode }}</span>
        <span v-if="step.finishedAt" class="tool-duration"
          >{{ ((Date.parse(step.finishedAt) - Date.parse(step.createdAt)) / 1000).toFixed(2) }} s</span
        >
        <button v-if="step.output" class="icon-button" aria-label="复制执行结果" @click="copy(logText)">
          <AppIcon name="copy" :size="14" />
        </button>
      </div>
      <p v-if="commandResult?.error" class="tool-result-note error-text">{{ commandResult.error }}</p>
      <p v-if="commandResult?.note" class="tool-result-note">{{ commandResult.note }}</p>
      <details class="tool-parameters">
        <summary>输入参数</summary>
        <pre class="tool-code">{{ pretty(step.input) }}</pre>
      </details>
      <details v-if="step.status !== 'running' && progress" class="tool-parameters">
        <summary>执行过程</summary>
        <pre class="tool-code">{{ progress }}</pre>
      </details>
      <span v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</span>
    </div>
  </details>
  <details v-else class="process-step tool-step" :class="step.status" :data-tool="step.name" :open="expanded">
    <summary>
      <span v-if="step.status === 'running'" class="spinner" />
      <AppIcon v-else :name="step.status === 'failed' ? 'close' : toolPresentation(step.name).icon" />
      <span class="step-name">{{ toolPresentation(step.name).label }}</span>
      <span v-if="target" class="step-divider">·</span>
      <span class="step-preview" :title="target">{{ target }}</span>
      <span class="step-status" :class="step.status">{{ toolStatus(step) }}</span>
      <AppIcon class="disclosure" name="chevron" :size="14" />
    </summary>
    <div class="tool-detail">
      <ToolResult :step="step" @open-file="(path, line) => $emit('openFile', path, line)" />
      <details class="tool-parameters">
        <summary>输入参数</summary>
        <pre class="tool-code">{{ pretty(step.input) }}</pre>
      </details>
      <details v-if="progress" class="tool-parameters" :open="step.status === 'running'">
        <summary>执行过程</summary>
        <pre class="tool-code">{{ progress }}</pre>
      </details>
      <div v-if="step.output" class="tool-result-bar">
        <span>{{ toolStatus(step) }}</span>
        <button class="icon-button" aria-label="复制执行结果" @click="copy(step.output)">
          <AppIcon name="copy" :size="14" />
        </button>
      </div>
      <span v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</span>
    </div>
  </details>
</template>
