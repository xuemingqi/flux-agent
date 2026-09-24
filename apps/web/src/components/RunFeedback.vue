<script setup lang="ts">
import { ref, watch } from 'vue';
import type { FeedbackInput, RunFeedback } from '@flux-agent/contracts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ feedback: RunFeedback | null; save: (input: FeedbackInput) => Promise<void> }>();
const editing = ref(false);
const comment = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
watch(
  () => props.feedback,
  (value) => {
    comment.value = value?.comment ?? '';
  },
  { immediate: true },
);

async function submit(rating: FeedbackInput['rating'], text: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await props.save({ rating, comment: text, version: props.feedback?.version ?? 0 });
    editing.value = false;
    notice.value = rating || text.trim() ? '反馈已保存' : '反馈已撤回';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '反馈保存失败，请重试。';
  } finally {
    busy.value = false;
  }
}

function edit() {
  comment.value = props.feedback?.comment ?? '';
  editing.value = !editing.value;
  notice.value = '';
}
</script>

<template>
  <div class="run-feedback" aria-label="回答反馈">
    <div class="feedback-actions">
      <button
        class="icon-button"
        :aria-pressed="feedback?.rating === 'helpful'"
        aria-label="有帮助"
        title="有帮助"
        :disabled="busy || editing"
        @click="submit(feedback?.rating === 'helpful' ? null : 'helpful', feedback?.comment ?? '')"
      >
        <AppIcon name="thumb-up" :size="15" />
      </button>
      <button
        class="icon-button"
        :aria-pressed="feedback?.rating === 'unhelpful'"
        aria-label="需改进"
        title="需改进"
        :disabled="busy || editing"
        @click="submit(feedback?.rating === 'unhelpful' ? null : 'unhelpful', feedback?.comment ?? '')"
      >
        <AppIcon name="thumb-down" :size="15" />
      </button>
      <button class="feedback-link" :disabled="busy" :aria-expanded="editing" @click="edit">
        {{ editing ? '取消编辑' : feedback?.comment ? '查看反馈' : '补充意见' }}
      </button>
      <button
        v-if="feedback?.rating || feedback?.comment"
        class="feedback-link"
        :disabled="busy"
        @click="submit(null, '')"
      >
        撤回反馈
      </button>
      <span v-if="notice" class="feedback-notice" role="status">{{ notice }}</span>
    </div>
    <form v-if="editing" class="feedback-editor" @submit.prevent="submit(feedback?.rating ?? null, comment)">
      <label
        >补充意见<textarea
          v-model="comment"
          aria-label="反馈意见"
          rows="3"
          maxlength="2000"
          :disabled="busy"
          placeholder="哪里有帮助，或需要怎样改进？"
        />
      </label>
      <div class="feedback-editor-footer">
        <span>仅保存到本机，不会自动变成长期记忆</span
        ><button class="primary-button" :disabled="busy">{{ busy ? '保存中…' : '保存反馈' }}</button>
      </div>
    </form>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </div>
</template>
