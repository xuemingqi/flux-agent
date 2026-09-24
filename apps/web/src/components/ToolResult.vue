<script setup lang="ts">
import { computed } from 'vue';
import { z } from 'zod';
import { runPlanSchema } from '@flux-agent/contracts';
import { parseToolObject, type ToolStep } from './tool-presentation';
import AppIcon from './AppIcon.vue';
import MessageContent from './MessageContent.vue';
import RunPlan from './RunPlan.vue';

const props = defineProps<{ step: ToolStep }>();
const emit = defineEmits<{ openFile: [path: string, line?: number] }>();
const input = computed(() => parseToolObject(props.step.input));
const result = computed(() => parseToolObject(props.step.output));
const entries = computed(() =>
  z
    .array(z.object({ name: z.string(), type: z.string() }))
    .catch([])
    .parse(result.value.entries),
);
const matches = computed(() =>
  z
    .array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }))
    .catch([])
    .parse(result.value.matches),
);
const memories = computed(() =>
  z
    .array(z.object({ id: z.string(), content: z.string() }))
    .catch([])
    .parse(result.value.memories),
);
const tasks = computed(() =>
  z
    .array(z.object({ name: z.string(), task: z.string() }))
    .catch([])
    .parse(input.value.tasks),
);
const plan = computed(() => {
  const parsed = runPlanSchema.safeParse(result.value);
  return parsed.success ? parsed.data : undefined;
});

function openEntry(name: string) {
  const root = String(input.value.path || '.').replace(/\/$/, '');
  emit('openFile', `${root}/${name}`);
}
</script>

<template>
  <div class="tool-result-content">
    <p v-if="step.status === 'running'" class="tool-result-caption">正在执行，结果会在这里更新…</p>
    <pre v-else-if="step.status === 'failed' || step.status === 'interrupted'" class="tool-result-error">{{
      step.output
    }}</pre>
    <template v-else-if="step.name === 'list_directory'">
      <p class="tool-result-caption">
        {{ entries.length }} 个项目<span v-if="result.truncated"> · 工具仅返回了部分目录项</span>
      </p>
      <div class="directory-list">
        <component
          :is="entry.type === 'file' ? 'button' : 'div'"
          v-for="entry in entries"
          :key="entry.name"
          class="directory-entry"
          @click="entry.type === 'file' && openEntry(entry.name)"
        >
          <AppIcon :name="entry.type === 'directory' ? 'folder' : 'file'" :size="16" /><span>{{ entry.name }}</span
          ><small>{{ entry.type === 'directory' ? '目录' : entry.type === 'symlink' ? '符号链接' : '文件' }}</small>
        </component>
      </div>
    </template>
    <template v-else-if="step.name === 'search_files'">
      <p class="tool-result-caption">
        搜索「{{ input.query }}」 · {{ matches.length }} 处匹配<span v-if="result.truncated">
          · 工具仅返回了部分结果</span
        >
      </p>
      <div class="search-matches">
        <button
          v-for="match in matches"
          :key="`${match.path}:${match.line}`"
          class="search-match"
          @click="$emit('openFile', match.path, match.line)"
        >
          <span
            ><AppIcon name="file" :size="14" />{{ match.path }}<small>第 {{ match.line }} 行</small></span
          ><code>{{ match.text }}</code>
        </button>
      </div>
      <p v-if="!matches.length" class="tool-result-caption">没有找到匹配内容。</p>
    </template>
    <RunPlan v-else-if="step.name === 'update_plan' && plan" :plan="plan" :status="step.status" />
    <template v-else-if="step.name === 'search_memories'">
      <p class="tool-result-caption">本次返回 {{ memories.length }} 条记忆 · 共 {{ result.total || 0 }} 条</p>
      <MessageContent
        v-for="memory in memories"
        :key="memory.id"
        class="tool-result-memory"
        :content="memory.content"
      />
      <p v-if="!memories.length" class="tool-result-caption">没有匹配的已确认记忆。</p>
    </template>
    <template v-else-if="step.name === 'propose_memory'">
      <p class="tool-result-caption">记忆候选 · 需到长期记忆页面确认后生效</p>
      <MessageContent class="tool-result-memory" :content="String(input.content || '')" />
    </template>
    <template v-else-if="step.name === 'delegate_tasks'">
      <p class="tool-result-caption">
        {{ input.mode === 'parallel' ? '并行' : '顺序' }}委派 · {{ tasks.length }} 个任务，执行进度见对话中的子 Agent。
      </p>
      <section v-for="task in tasks" :key="task.name" class="tool-result-task">
        <h3>{{ task.name }}</h3>
        <MessageContent :content="task.task" />
      </section>
    </template>
    <dl v-else-if="step.name === 'get_current_time'" class="tool-result-values">
      <dt>时间</dt>
      <dd>{{ result.localTime }}</dd>
      <dt>时区</dt>
      <dd>{{ result.timeZone }}</dd>
      <dt>ISO</dt>
      <dd>{{ result.iso }}</dd>
    </dl>
    <pre v-else class="tool-result-raw">{{ step.output || '工具未返回文本内容。' }}</pre>
  </div>
</template>
