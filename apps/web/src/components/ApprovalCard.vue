<script setup lang="ts">
import type { Approval } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';
defineProps<{ approval: Approval; busy: boolean }>();
defineEmits<{ decide: [decision: 'approved' | 'denied']; inspect: [] }>();
const labels = {
  pending: '等待你的确认',
  approved: '已允许本次修改',
  denied: '已拒绝',
  expired: '审批已过期',
  cancelled: '审批已取消',
};
</script>
<template>
  <section
    class="approval-card"
    :class="{ 'approval-pending': approval.status === 'pending' }"
    :aria-label="
      approval.kind === 'mcp' ? 'MCP 调用审批' : approval.kind === 'capability' ? '能力管理审批' : '文件修改审批'
    "
  >
    <div class="approval-heading">
      <AppIcon name="shield" :size="16" /><strong>{{ labels[approval.status] }}</strong
      ><span>{{
        approval.kind === 'mcp' ? 'MCP 调用' : approval.kind === 'capability' ? '能力管理' : '文件修改'
      }}</span>
    </div>
    <p class="approval-path">{{ approval.path }}</p>
    <button class="approval-preview" @click="$emit('inspect')">
      <AppIcon name="open-panel" :size="15" />查看修改前后内容
    </button>
    <template v-if="approval.status === 'pending'">
      <p class="approval-note">仅授权这一次操作。等待期间资源变化会使本次操作失败。</p>
      <div class="dialog-actions">
        <button :disabled="busy" @click="$emit('decide', 'denied')">拒绝</button
        ><button class="primary-action" :disabled="busy" @click="$emit('decide', 'approved')">允许本次修改</button>
      </div>
    </template>
  </section>
</template>
