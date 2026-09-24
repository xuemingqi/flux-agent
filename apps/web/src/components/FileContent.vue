<script setup lang="ts">
defineProps<{ content: string; highlightedLine?: number }>();
</script>

<template>
  <div class="file-code" aria-label="文件源码">
    <div
      v-for="(line, index) in content.split('\n')"
      :key="index"
      class="code-line"
      :class="{ highlighted: highlightedLine === index + 1 }"
      :data-line="index + 1"
    >
      <span class="line-number" aria-hidden="true">{{ index + 1 }}</span
      ><code>{{ line || ' ' }}</code>
    </div>
  </div>
</template>
