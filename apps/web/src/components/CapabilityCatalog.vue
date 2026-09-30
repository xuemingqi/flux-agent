<script setup lang="ts">
import { useId } from 'vue';
import AppIcon from './AppIcon.vue';

defineProps<{
  title: string;
  description: string;
  searchLabel: string;
  query: string;
  filter: string;
  total: number;
  loading: boolean;
  busy: boolean;
}>();
defineEmits<{ 'update:query': [value: string]; 'update:filter': [value: string]; refresh: [] }>();
const titleId = useId();
const filters = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已禁用' },
];
</script>

<template>
  <section class="capability-page" :aria-labelledby="titleId" :aria-busy="loading">
    <header class="capability-heading">
      <h2 :id="titleId">{{ title }}</h2>
      <div class="capability-toolbar">
        <label class="capability-search">
          <AppIcon name="search" :size="18" />
          <input
            type="search"
            :value="query"
            :aria-label="searchLabel"
            :placeholder="searchLabel"
            maxlength="500"
            @input="$emit('update:query', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <button
          class="icon-button capability-refresh"
          :class="{ refreshing: loading }"
          :disabled="loading || busy"
          aria-label="刷新列表"
          title="刷新列表"
          @click="$emit('refresh')"
        >
          <AppIcon name="refresh" :size="20" />
        </button>
        <slot name="actions" />
      </div>
      <p class="capability-subtitle">{{ description }}</p>
    </header>
    <div class="capability-filters" role="group" aria-label="按启用状态筛选">
      <button
        v-for="item in filters"
        :key="item.value"
        :class="{ active: filter === item.value }"
        :aria-pressed="filter === item.value"
        @click="$emit('update:filter', item.value)"
      >
        {{ item.label }}
      </button>
    </div>
    <slot name="notice" />
    <div class="capability-section-heading">
      <h3>已添加</h3>
      <span>{{ total }}</span>
    </div>
    <p v-if="loading && !total" class="capability-loading" role="status">正在读取列表…</p>
    <slot v-else />
    <p class="capability-footnote">本机的所有工作区均可使用启用的能力。</p>
  </section>
</template>
