<script setup lang="ts">
import type { WorldCommunication } from './agent-world';
import MessageContent from './MessageContent.vue';
defineProps<{ messages: WorldCommunication[]; replayable?: boolean }>();
defineEmits<{ replay: [message: WorldCommunication] }>();
const labels = { pending: '待接收', delivered: '已送达', not_delivered: '未送达 · 对方已结束' };
</script>
<template>
  <section v-if="messages.length" class="agent-communications" aria-label="Agent 交流记录">
    <div class="communication-heading">
      <h3>伙伴之间的交流</h3>
      <span>{{ messages.length }} 条真实消息</span>
    </div>
    <ol>
      <li v-for="message in messages" :key="message.id" :data-message-id="message.id">
        <div class="communication-route">
          <strong>{{ message.fromName }}</strong
          ><span aria-label="发送给">→</span><strong>{{ message.toName }}</strong
          ><small>{{ message.kind === 'handoff' ? '结果交接 · ' : '' }}{{ labels[message.status] }}</small>
        </div>
        <MessageContent :content="message.content" />
        <button v-if="replayable && message.status !== 'not_delivered'" type="button" @click="$emit('replay', message)">
          回放这次交流
        </button>
      </li>
    </ol>
  </section>
</template>
<style scoped>
.agent-communications {
  margin: 22px 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px;
  min-width: 0;
}
.communication-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.communication-heading h3 {
  font-size: 14px;
  font-weight: 500;
  margin: 0;
}
.communication-heading > span,
.communication-route small {
  color: var(--muted);
  font-size: 11px;
}
ol {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  max-height: 340px;
  overflow: auto;
}
li + li {
  border-top: 1px solid var(--border);
  margin-top: 14px;
  padding-top: 14px;
}
.communication-route {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.communication-route strong {
  font-weight: 500;
  color: #b9d2bf;
  overflow-wrap: anywhere;
}
.communication-route small {
  margin-left: auto;
}
:deep(.markdown) {
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.8;
  margin: 8px 0;
}
button {
  font: inherit;
  font-size: 11px;
  color: var(--muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 9px;
  cursor: pointer;
}
button:hover {
  color: var(--text);
}
</style>
