<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { isRunActive, type Approval, type Run } from '@flux-agent/contracts';
import AgentCommunications from './AgentCommunications.vue';
const AgentAnimalStage = defineAsyncComponent(() => import('./AgentAnimalStage.vue'));
import RunStepContent from './RunStepContent.vue';
import RunPlan from './RunPlan.vue';
import ApprovalCard from './ApprovalCard.vue';
import {
  inspectWorldApproval,
  inspectWorldTool,
  worldAgents,
  worldCommunications,
  type WorldCommunication,
} from './agent-world';
import type { ToolInspection, ToolStep } from './tool-presentation';

const props = defineProps<{
  turns: { run: Run; question: string }[];
  approvalPending?: string;
}>();
const emit = defineEmits<{
  decide: [runId: string, approvalId: string, decision: 'approved' | 'denied'];
  inspect: [inspection: ToolInspection];
  openFile: [path: string, line?: number];
}>();
const selectedRunId = ref('');
const selectedAgentId = ref('');
const stage = ref<{ replay(message: WorldCommunication): void }>();
const turn = computed(() => props.turns.find((entry) => entry.run.id === selectedRunId.value) ?? props.turns.at(-1));
const communications = computed(() => worldCommunications(turn.value?.run.subagents ?? []));
const agents = computed(() => (turn.value ? worldAgents(turn.value.run, turn.value.question, props.turns) : []));
const selected = computed(() => agents.value.find((agent) => agent.id === selectedAgentId.value) ?? agents.value[0]);
const activeRun = computed(() => props.turns.find((entry) => isRunActive(entry.run.status))?.run);
// 查看历史轮次或其他角色时，当前任务的审批仍然可达。
const approvals = computed(() =>
  props.turns.flatMap(({ run }) =>
    run.approvals.filter((entry) => entry.status === 'pending').map((approval) => ({ run, approval })),
  ),
);

watch(
  () => props.turns.at(-1)?.run.id,
  (id) => {
    selectedRunId.value = id ?? '';
  },
  { immediate: true },
);
watch(
  () => turn.value?.run.id,
  () => {
    selectedAgentId.value = '';
  },
);

function inspect(step: ToolStep) {
  if (turn.value && selected.value) emit('inspect', inspectWorldTool(turn.value.run, selected.value.id, step));
}
function inspectApproval(run: Run, approval: Approval) {
  const inspection = inspectWorldApproval(run, approval);
  if (inspection) emit('inspect', inspection);
}
function inspectHistory(runId: string, agentId: string, step: ToolStep) {
  const run = props.turns.find((turn) => turn.run.id === runId)?.run;
  if (run) emit('inspect', inspectWorldTool(run, agentId, step));
}
</script>

<template>
  <div class="agent-world">
    <div class="world-heading">
      <div>
        <span class="eyebrow">AGENT WORKSPACE</span>
        <h2>协作空间</h2>
      </div>
      <label v-if="turns.length > 1" class="world-turn-picker">
        展示轮次
        <select v-model="selectedRunId" aria-label="展示轮次">
          <option v-for="(entry, index) in turns" :key="entry.run.id" :value="entry.run.id">
            第 {{ index + 1 }} 轮 · {{ entry.question.slice(0, 35) }}
          </option>
        </select>
      </label>
    </div>
    <div v-if="!turn || !selected" class="world-empty">
      <span class="world-empty-animal" aria-hidden="true">🦊</span>
      <h3>等待第一个任务</h3>
      <p>发送消息后，在这里查看 Agent 的工作状态与执行过程。</p>
    </div>
    <template v-else>
      <p class="world-question">{{ turn.question }}</p>
      <div v-if="approvals.length" class="world-approvals">
        <p v-if="approvals.some((entry) => entry.run.id !== turn?.run.id)" class="world-note">
          当前运行的任务正在等待审批。
        </p>
        <ApprovalCard
          v-for="entry in approvals"
          :key="entry.approval.id"
          :approval="entry.approval"
          :busy="!!approvalPending"
          @inspect="inspectApproval(entry.run, entry.approval)"
          @decide="emit('decide', entry.run.id, entry.approval.id, $event)"
        />
      </div>
      <AgentAnimalStage
        ref="stage"
        :key="turn.run.id"
        :agents="agents"
        :selected-id="selected.id"
        :communications="communications"
        @select="selectedAgentId = $event"
        @inspect="inspectHistory"
      />
      <AgentCommunications :messages="communications" replayable @replay="stage?.replay($event)" />
      <p v-if="agents.length > 1 && !communications.length" class="world-note">
        本轮暂无伙伴间消息。有需要时，Agent 可以互相提问和分享发现。
      </p>
      <div v-if="activeRun" class="world-steering">
        <div
          v-for="message in activeRun.steering.filter((entry) => entry.status === 'pending')"
          :key="message.id"
          class="steering-message"
        >
          <span class="steering-label">调整方向 · 等待当前执行单元完成</span>
          <div class="user-text">{{ message.content }}</div>
        </div>
      </div>
      <RunPlan v-if="turn.run.plan" :plan="turn.run.plan" :status="turn.run.status" />
      <section class="world-agent-detail" :aria-label="`${selected.name} 的执行过程`">
        <div class="world-detail-heading">
          <h3>{{ selected.name }}</h3>
          <span>{{ selected.label }}</span>
        </div>
        <p class="world-agent-task">{{ selected.task }}</p>
        <p v-if="selected.activity === 'failed'" class="run-error" role="alert">{{ selected.bubble }}</p>
        <div v-if="selected.steps.length" :key="`${turn.run.id}:${selected.id}`" class="run-steps">
          <RunStepContent
            v-for="step in selected.steps"
            :key="step.id"
            :step="step"
            :expanded="true"
            @inspect="inspect"
            @open-file="(path, line) => emit('openFile', path, line)"
          />
        </div>
        <p v-else class="world-note">{{ selected.bubble }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.agent-world {
  max-width: 1600px;
  padding: 24px 32px;
  margin: 0 auto;
}
.world-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.world-heading h2 {
  margin: 7px 0 0;
  font-size: 22px;
  font-weight: 500;
}
.world-turn-picker {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--muted);
  font-size: 12px;
  min-width: 0;
  max-width: 100%;
}
.world-turn-picker select {
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 7px;
  min-width: 0;
  max-width: 260px;
  flex: 1;
  font: inherit;
}
.world-question {
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow: auto;
  margin: 12px 0;
}
.world-agent-detail {
  margin-top: 26px;
  min-width: 0;
}
.world-detail-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.world-detail-heading h3 {
  font-size: 15px;
  font-weight: 500;
  margin: 0;
  overflow-wrap: anywhere;
}
.world-detail-heading > span {
  color: var(--muted);
  font-size: 12px;
  flex-shrink: 0;
}
.world-agent-task {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 12px 0 22px;
}
.world-note {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}
.world-empty {
  text-align: center;
  padding: 65px 10px;
}
.world-empty h3 {
  font-size: 17px;
  font-weight: 500;
  margin-top: 24px;
}
.world-empty p {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.8;
}
.world-steering {
  margin-top: 18px;
}
@media (max-width: 760px) {
  .agent-world {
    padding: 22px 16px;
  }
}
.world-empty-animal {
  display: block;
  font-size: 88px;
  margin-bottom: 16px;
}
</style>
