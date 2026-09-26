<script setup lang="ts">
import type { AgentTask } from '@flux-agent/contracts';
import AgentCommunications from './AgentCommunications.vue';
import { worldCommunications } from './agent-world';
import RunStepContent from './RunStepContent.vue';
import ContextDetails from './ContextDetails.vue';
import type { ToolInspection } from './tool-presentation';
defineProps<{ tasks: AgentTask[] }>();
defineEmits<{ inspect: [inspection: ToolInspection]; openFile: [path: string, line?: number] }>();
const labels: Record<AgentTask['status'], string> = {
  queued: '等待开始',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

function activity(task: AgentTask): string {
  if (task.status !== 'running') return labels[task.status];
  if (task.compression) return `压缩上下文 ${task.compression.completed}/${task.compression.total}`;
  const tool = task.steps.findLast((step) => step.kind === 'tool' && step.status === 'running');
  if (tool?.kind === 'tool') return `执行 ${tool.name}`;
  return task.steps.at(-1)?.kind === 'reasoning' ? '正在思考' : '正在生成';
}
</script>
<template>
  <section v-if="tasks.length" class="subagent-tasks" aria-label="子 Agent 任务">
    <p class="subagent-heading">
      子 Agent · {{ tasks.filter((task) => task.status === 'succeeded').length }}/{{ tasks.length }} 已完成
      <span v-if="tasks.some((task) => task.status === 'failed')" class="error-text">
        · {{ tasks.filter((task) => task.status === 'failed').length }} 个失败</span
      >
    </p>
    <details v-for="task in tasks" :key="task.id" class="subagent-task" :aria-label="`子 Agent ${task.name}`">
      <summary>
        <span v-if="task.status === 'running'" class="spinner" /><span>{{ task.name }}</span
        ><small :class="{ 'error-text': task.status === 'failed' }">{{ activity(task) }}</small>
      </summary>
      <p class="subagent-description">
        {{ task.context.length }} 次模型请求 · {{ task.steps.filter((step) => step.kind === 'tool').length }} 次工具调用
      </p>
      <p v-if="task.error" class="error-text">{{ task.error }}</p>
      <p class="subagent-description">{{ task.task }}</p>
      <p v-if="task.compression" role="status">
        正在压缩上下文 · {{ task.compression.completed }}/{{ task.compression.total }} 个片段完成…
      </p>
      <ContextDetails :records="task.context" :compaction="task.compaction" />
      <div class="run-steps">
        <RunStepContent
          v-for="step in task.steps"
          :key="step.id"
          :step="step"
          @inspect="$emit('inspect', { id: `${task.id}/${step.id}`, step: $event })"
          @open-file="(path, line) => $emit('openFile', path, line)"
        />
      </div>
    </details>
    <AgentCommunications :messages="worldCommunications(tasks)" />
  </section>
</template>
