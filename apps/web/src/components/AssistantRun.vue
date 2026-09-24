<script setup lang="ts">
import { computed, ref } from 'vue';
import { isRunActive, permissionLabels, type Run, type RunStatus, type FeedbackInput } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';
import RunStepContent from './RunStepContent.vue';
import ApprovalCard from './ApprovalCard.vue';
import ContextDetails from './ContextDetails.vue';
import RunPlan from './RunPlan.vue';
import RunFeedback from './RunFeedback.vue';
import SubagentTasks from './SubagentTasks.vue';
import type { ToolInspection, ToolStep } from './tool-presentation';

const props = defineProps<{
  run: Run;
  trace?: boolean;
  approvalPending?: string;
  saveFeedback: (input: FeedbackInput) => Promise<void>;
}>();
const emit = defineEmits<{
  decide: [approvalId: string, decision: 'approved' | 'denied'];
  inspect: [inspection: ToolInspection];
  openFile: [path: string, line?: number];
}>();
function inspect(step: ToolStep) {
  emit('inspect', {
    id: `${props.run.id}/${step.id}`,
    step,
    approval: props.run.approvals.find((entry) => entry.toolCallId === step.id),
  });
}
function inspectApproval(toolCallId: string) {
  const step = tools.value.find((entry) => entry.id === toolCallId);
  if (step) inspect(step);
}
const showProcess = ref(true);
const copyStatus = ref('');
const tools = computed(() => props.run.steps.filter((step) => step.kind === 'tool'));
const reasoning = computed(() => props.run.steps.some((step) => step.kind === 'reasoning'));
const visibleSteps = computed(() => {
  if (showProcess.value || props.trace) return props.run.steps;
  const finalText = props.run.steps.findLast((step) => step.kind === 'text');
  return props.run.steps.filter((step) => step.kind === 'steering' || step === finalText);
});
const statusLabels: Record<RunStatus, string> = {
  running: '正在运行',
  waiting_approval: '等待审批',
  interrupted: '已中断',
  cancelling: '正在停止',
  succeeded: '已完成',
  failed: '运行失败',
  cancelled: '已停止',
};
const duration = computed(() =>
  props.run.finishedAt
    ? `${((Date.parse(props.run.finishedAt) - Date.parse(props.run.createdAt)) / 1000).toFixed(1)} s`
    : '',
);

async function copyAnswer() {
  try {
    await navigator.clipboard.writeText(props.run.output);
    copyStatus.value = '已复制';
  } catch {
    copyStatus.value = '复制失败';
  }
}
</script>

<template>
  <div class="assistant-run" :class="{ 'trace-run': trace }">
    <ContextDetails :records="run.context" :compaction="run.compaction" />
    <SubagentTasks
      :tasks="run.subagents.filter((task) => !task.parentToolCallId)"
      @inspect="$emit('inspect', $event)"
      @open-file="(path, line) => $emit('openFile', path, line)"
    />
    <RunPlan v-if="run.plan" :plan="run.plan" :status="run.status" />
    <button
      v-if="!trace && (tools.length || reasoning)"
      class="process-summary"
      :aria-expanded="showProcess"
      @click="showProcess = !showProcess"
    >
      <AppIcon name="trace" :size="16" /><span
        >思考与执行<span v-if="tools.length"> · {{ tools.length }} 次工具调用</span></span
      ><AppIcon name="down" :size="14" :class="{ rotated: !showProcess }" />
    </button>
    <div class="run-steps">
      <template v-for="step in visibleSteps" :key="step.id">
        <RunStepContent
          :step="step"
          :expanded="trace"
          @inspect="inspect"
          @open-file="(path, line) => $emit('openFile', path, line)"
        />
        <SubagentTasks
          v-if="step.kind === 'tool' && step.name === 'delegate_tasks'"
          :tasks="run.subagents.filter((task) => task.parentToolCallId === step.id)"
          @inspect="$emit('inspect', $event)"
          @open-file="(path, line) => $emit('openFile', path, line)"
        />
      </template>
    </div>
    <div
      v-for="message in run.steering.filter((entry) => entry.status !== 'applied')"
      :key="message.id"
      class="steering-message"
      :aria-label="message.status === 'pending' ? '待处理的补充消息' : '未处理的补充消息'"
    >
      <span class="steering-label">{{
        message.status === 'pending' ? '调整方向 · 等待当前执行单元完成' : '调整方向 · 本轮结束前未处理，请重新发送'
      }}</span>
      <div class="user-text">{{ message.content }}</div>
    </div>
    <ApprovalCard
      v-for="approval in run.approvals"
      :key="approval.id"
      :approval="approval"
      :busy="!!approvalPending"
      @inspect="inspectApproval(approval.toolCallId)"
      @decide="(decision) => $emit('decide', approval.id, decision)"
    />
    <p v-if="isRunActive(run.status)" class="activity-indicator" role="status">
      <span class="spinner" />{{
        run.status === 'cancelling'
          ? '正在停止运行…'
          : run.status === 'waiting_approval'
            ? '等待你确认文件修改…'
            : run.compression
              ? `正在压缩上下文 · ${run.compression.completed}/${run.compression.total} 个片段完成…`
              : !run.steps.length
                ? '正在连接模型…'
                : tools.some((tool) => tool.name === 'delegate_tasks' && tool.status === 'running')
                  ? '正在等待子 Agent，进度见上方子任务…'
                  : tools.some((tool) => tool.status === 'running')
                    ? '工具执行中…'
                    : '正在生成…'
      }}
    </p>
    <p v-if="run.error" class="run-error" role="alert"><AppIcon name="close" :size="16" />{{ run.error.message }}</p>
    <div v-if="!isRunActive(run.status)" class="run-detail">
      <span :class="{ 'error-text': run.status === 'failed' }">{{ statusLabels[run.status] }}</span
      ><span v-if="duration">{{ duration }}</span
      ><span v-if="run.usage">{{ run.usage.totalTokens }} tokens</span>
      <span>{{ permissionLabels[run.permissionMode] }}</span>
      <button
        v-if="run.output"
        class="icon-button copy-answer"
        :aria-label="copyStatus || '复制回复'"
        :title="copyStatus || '复制回复'"
        @click="copyAnswer"
      >
        <AppIcon :name="copyStatus === '已复制' ? 'check' : 'copy'" :size="14" />
      </button>
    </div>
    <RunFeedback v-if="!isRunActive(run.status)" :feedback="run.feedback" :save="saveFeedback" />
  </div>
</template>
