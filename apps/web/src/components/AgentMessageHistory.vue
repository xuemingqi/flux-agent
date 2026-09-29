<script setup lang="ts">
import MessageContent from './MessageContent.vue';
import type { WorldHistoryRound } from './agent-world';
import { toolPresentation, toolStatus, toolTarget, type ToolStep } from './tool-presentation';

defineProps<{ rounds: WorldHistoryRound[] }>();
defineEmits<{ inspect: [runId: string, agentId: string, step: ToolStep] }>();
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <div class="agent-message-history">
    <section v-for="round in rounds" :key="round.id" class="history-round" :aria-label="round.label">
      <div class="history-round-heading">{{ round.label }}</div>
      <div class="history-task"><MessageContent :content="round.task" /></div>
      <ol class="history-entries">
        <li v-for="entry in round.entries" :key="entry.id" :data-entry-id="entry.id">
          <template v-if="entry.kind === 'message'">
            <div class="history-meta">
              <span>{{ entry.label }}</span
              ><time :datetime="entry.createdAt">{{ time(entry.createdAt) }}</time>
            </div>
            <MessageContent :content="entry.content" />
          </template>
          <details v-else class="history-tool">
            <summary>
              <span>{{ toolPresentation(entry.step.name).label }}</span>
              <small>{{ toolStatus(entry.step) }}</small>
            </summary>
            <p class="history-target">{{ toolTarget(entry.step) }}</p>
            <button
              v-if="['read_file', 'write_file'].includes(entry.step.name) && entry.step.status === 'succeeded'"
              type="button"
              @click="$emit('inspect', round.id, round.agentId, entry.step)"
            >
              查看文件详情
            </button>
            <div v-if="entry.step.input">
              <small>输入</small>
              <pre>{{ entry.step.input }}</pre>
            </div>
            <div v-if="entry.step.progress.length">
              <small>执行过程</small>
              <pre>{{ entry.step.progress.join('\n') }}</pre>
            </div>
            <div v-if="entry.step.output">
              <small>结果</small>
              <pre>{{ entry.step.output }}</pre>
            </div>
          </details>
        </li>
      </ol>
      <p v-if="!round.entries.length" class="history-empty">等待消息…</p>
    </section>
  </div>
</template>

<style scoped>
.agent-message-history {
  color: #dfe7f2;
}
.history-round + .history-round {
  margin-top: 28px;
}
.history-round-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 600;
  color: #74e9f8;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
}
.history-round-heading::before {
  width: 5px;
  height: 5px;
  content: '';
  background: #48dff7;
  box-shadow: 0 0 8px #48dff799;
}
.history-task {
  background: #0f1822;
  border: 1px solid #253746;
  border-left: 2px solid #48dff7;
  padding: 11px 13px;
  border-radius: 8px;
  margin-bottom: 16px;
  box-shadow: inset 0 1px #ffffff05;
}
.history-task :deep(.markdown) {
  color: #dfe7f2;
}
.history-entries {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history-entries > li + li {
  border-top: 1px solid #29323e;
  margin-top: 18px;
  padding-top: 18px;
}
.history-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #8e9bad;
  font-size: 10px;
  margin-bottom: 8px;
}
.history-meta span {
  color: #b8c9da;
}
.history-meta time {
  flex-shrink: 0;
  color: #687789;
}
.history-tool {
  padding: 10px 12px;
  background: #111821;
  border: 1px solid #293746;
  border-radius: 7px;
  font-size: 12px;
}
.history-tool summary {
  cursor: pointer;
  color: #b9ddea;
}
.history-tool small {
  color: #7e8b9c;
  font-size: 10px;
}
.history-tool summary small {
  float: right;
  color: #9d8cff;
}
.history-target {
  color: #8e9bad;
  overflow-wrap: anywhere;
}
.history-tool pre {
  font:
    11px/1.7 ui-monospace,
    monospace;
  overflow: auto;
  max-height: 240px;
  color: #cbd8e6;
  background: #090e14;
  border: 1px solid #242f3b;
  padding: 10px;
  border-radius: 6px;
}
.history-tool button {
  color: #75e8f8;
  background: #10222c;
  border: 1px solid #315765;
  border-radius: 5px;
  padding: 4px 8px;
  font: inherit;
  cursor: pointer;
  margin-bottom: 12px;
}
.history-tool button:hover {
  color: #e8fbff;
  border-color: #48dff7;
  background: #14303b;
}
.history-empty {
  color: #7e8b9c;
  font-size: 12px;
}
</style>
