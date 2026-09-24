<script setup lang="ts">
import type { ContextRecord, ContextCompaction } from '@flux-agent/contracts';
defineProps<{ records: ContextRecord[]; compaction?: ContextCompaction | null }>();
</script>
<template>
  <details v-if="records.length" class="context-details">
    <summary>
      本轮上下文 · {{ records.length }} 次模型请求<span v-if="compaction"> · 已压缩</span
      ><span v-if="records.at(-1)?.memories.length"> · {{ records.at(-1)?.memories.length }} 条记忆</span>
    </summary>
    <details v-if="compaction" class="context-record">
      <summary>
        历史摘要 · {{ compaction.coveredMessages }} 条消息 · {{ compaction.beforeTokens.toLocaleString() }} →
        {{ compaction.afterTokens.toLocaleString() }} tokens（估算）
      </summary>
      <p class="context-summary">{{ compaction.summary }}</p>
      <p>摘要与原始记录已保存，后续对话复用摘要。</p>
      <p v-if="compaction.targetTokens">
        压缩目标：整个输入不超过 {{ compaction.targetTokens.toLocaleString() }} tokens。
      </p>
      <p v-if="compaction.warning" class="error-text">{{ compaction.warning }}</p>
    </details>
    <div v-for="record in records" :key="record.step" class="context-record">
      <p>
        第 {{ record.step }} 次请求 · 保守估算 {{ record.estimatedTokens.toLocaleString() }} tokens ·
        {{ record.contextWindowTokens ? '压缩触发阈值' : '参考预算' }} {{ record.budgetTokens.toLocaleString() }} tokens
        <span v-if="record.contextWindowTokens">
          · 模型窗口 {{ record.contextWindowTokens.toLocaleString() }} tokens</span
        >
      </p>
      <p>
        保留 {{ record.keptTurns }} 轮<span v-if="record.omittedTurns">
          · {{ record.omittedTurns }} 轮历史未发送（记录仍保留）</span
        ><span v-if="record.summarizedMessages"> · {{ record.summarizedMessages }} 条消息由摘要承接</span
        ><span v-if="record.truncatedToolResults"> · {{ record.truncatedToolResults }} 份工具结果已缩短</span>
      </p>
      <ul v-if="record.memories.length">
        <li v-for="memory in record.memories" :key="memory.id">
          <span>记忆 v{{ memory.version }}</span> {{ memory.excerpt }}
        </li>
      </ul>
      <p v-else>未引用长期记忆</p>
      <p v-if="record.compressionError" class="error-text">{{ record.compressionError }}</p>
      <p v-if="record.compressionWarning" class="error-text">{{ record.compressionWarning }}</p>
    </div>
  </details>
</template>
