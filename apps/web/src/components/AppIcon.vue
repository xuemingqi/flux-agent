<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h8',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  agents: 'M8 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM2 21v-4a6 6 0 0 1 12 0v4M17 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 5 5v2',
  'open-panel': 'M14 3v18M4 3h16v18H4V3ZM7 12h4m-2-2 2 2-2 2',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  refresh: 'M20 7V3l-3 3A8 8 0 1 0 3 12M20 3v5h-5M20 12a8 8 0 0 1-8 8',
  more: 'M4 12h.01M12 12h.01M20 12h.01',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5',
  'thumb-up': 'M7 10v11H3V10h4Zm0 0 5-8h1a2 2 0 0 1 2 2l-1 5h5a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7',
  'thumb-down': 'M7 14V3H3v11h4Zm0 0 5 8h1a2 2 0 0 0 2-2l-1-5h5a2 2 0 0 0 2-2l-2-8a2 2 0 0 0-2-2H7',
  memory: 'M5 4h14v16H5zM9 1v3M15 1v3M9 20v3M15 20v3M1 8h4M1 16h4M19 8h4M19 16h4M9 8h6v8H9z',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4ZM8 12l3 3 5-5',
  folder: 'M3 7V5h7l2 2h9v13H3V7Z',
  plus: 'M12 5v14M5 12h14',
  sidebar: 'M8 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  arrow: 'M12 19V5M5 12l7-7 7 7',
  chevron: 'm9 5 7 7-7 7',
  down: 'm5 9 7 7 7-7',
  terminal: 'm5 7 4 5-4 5M12 17h6M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
  thought: 'M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 .7-1 2-1 2H9s0-1.3-1-2Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M9 9h12v12H9zM15 5V3H3v12h2',
  clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  trace: 'M5 4v16M5 7h7M5 17h7M12 4h8v6h-8zM12 14h8v6h-8z',
  code: 'm8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18',
  stop: 'M6 6h12v12H6z',
};
</script>

<template>
  <svg
    :width="size || 18"
    :height="size || 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.spark" />
  </svg>
</template>
