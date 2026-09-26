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
.history-round + .history-round {
  margin-top: 28px;
}
.history-round-heading {
  font-size: 11px;
  font-weight: 600;
  color: #516b91;
  margin-bottom: 10px;
}
.history-task {
  background: #eef2f7;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 16px;
}
.history-entries {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history-entries > li + li {
  border-top: 1px solid #e6eaf0;
  margin-top: 18px;
  padding-top: 18px;
}
.history-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #65748a;
  font-size: 10px;
  margin-bottom: 8px;
}
.history-meta time {
  flex-shrink: 0;
}
.history-tool {
  font-size: 12px;
}
.history-tool summary {
  cursor: pointer;
  color: #4a607c;
}
.history-tool small {
  color: #65748a;
  font-size: 10px;
}
.history-tool summary small {
  float: right;
}
.history-target {
  overflow-wrap: anywhere;
}
.history-tool pre {
  font:
    11px/1.7 ui-monospace,
    monospace;
  overflow: auto;
  max-height: 240px;
  background: #edf1f6;
  padding: 10px;
  border-radius: 6px;
}
.history-tool button {
  color: #315f9c;
  background: none;
  border: 1px solid #cbd6e5;
  border-radius: 5px;
  padding: 4px 8px;
  font: inherit;
  cursor: pointer;
  margin-bottom: 12px;
}
.history-empty {
  color: #65748a;
  font-size: 12px;
}
</style>
