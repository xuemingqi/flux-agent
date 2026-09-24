<script setup lang="ts">
import { computed } from 'vue';
import { isRunActive, type RunPlan, type RunStatus } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ plan: RunPlan; status: RunStatus }>();
const completed = computed(() => props.plan.steps.filter((step) => step.status === 'completed').length);
const unfinished = computed(() =>
  props.plan.steps.some((step) => ['pending', 'in_progress', 'blocked'].includes(step.status)),
);
const labels = { pending: '待开始', in_progress: '进行中', completed: '已完成', blocked: '受阻', skipped: '已跳过' };
</script>

<template>
  <details class="run-plan" :open="isRunActive(status) || unfinished" aria-label="任务计划">
    <summary>
      <AppIcon name="trace" :size="15" /><span>任务计划</span>
      <span class="plan-count">{{ completed }}/{{ plan.steps.length }} 已完成</span>
      <span v-if="!isRunActive(status) && unfinished" class="plan-unfinished">有未完成步骤</span>
      <AppIcon name="down" :size="14" />
    </summary>
    <p class="plan-explanation">{{ plan.explanation }}</p>
    <ol>
      <li v-for="(step, index) in plan.steps" :key="step.id" :class="`plan-${step.status}`">
        <span class="plan-step-marker">
          <AppIcon v-if="step.status === 'completed'" name="check" :size="14" />
          <span v-else-if="step.status === 'in_progress' && isRunActive(status)" class="spinner" />
          <span v-else>{{ index + 1 }}</span>
        </span>
        <span class="plan-step-title">{{ step.title }}</span>
        <span class="plan-step-status">{{
          step.status === 'in_progress' && !isRunActive(status) ? '未完成' : labels[step.status]
        }}</span>
      </li>
    </ol>
  </details>
</template>
