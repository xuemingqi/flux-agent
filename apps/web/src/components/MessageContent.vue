<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const props = defineProps<{ content: string }>();
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
// 禁用远程图片，避免模型输出触发浏览器向外部地址自动发送请求。
markdown.disable('image');
const rendered = computed(() => DOMPurify.sanitize(markdown.render(props.content)));
</script>

<template>
  <div class="markdown" v-html="rendered" />
</template>
