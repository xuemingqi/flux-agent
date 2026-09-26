<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue';
import { createAnimalScene, animalNames, animalEmoji } from './animal-scene';
import type { WorldAgent, WorldCommunication } from './agent-world';
import type { ToolStep } from './tool-presentation';
import AgentMessageHistory from './AgentMessageHistory.vue';
import MessageContent from './MessageContent.vue';

const props = defineProps<{ agents: WorldAgent[]; selectedId: string; communications: WorldCommunication[] }>();
const emit = defineEmits<{ select: [id: string]; inspect: [runId: string, agentId: string, step: ToolStep] }>();
const canvas = ref<HTMLCanvasElement>();
const container = ref<HTMLElement>();
const failed = ref(false);
const ready = ref(false);
const paused = ref(false);
const encounterPhase = ref<string | null>(null);
const active = ref<{ message: WorldCommunication; replay: boolean } | null>(null);
const inspection = ref<{ kind: 'agent'; id: string } | { kind: 'message'; message: WorldCommunication } | null>(null);
const insightPanel = ref<HTMLElement>();
const encounterButton = ref<HTMLButtonElement>();
const insightId = useId();
const insight = computed(() => {
  const current = inspection.value;
  if (current?.kind === 'agent') {
    const index = props.agents.findIndex((agent) => agent.id === current.id);
    const agent = props.agents[index];
    if (agent)
      return {
        title: agent.name,
        subtitle: `${animalNames[index % 4]} · ${agent.label}`,
        history: agent.history,
        count: agent.history.reduce((count, round) => count + round.entries.length, 0),
        content: '',
      };
  } else if (current?.kind === 'message') {
    const message = props.communications.find((entry) => entry.id === current.message.id) ?? current.message;
    return {
      title: `${message.fromName} → ${message.toName}`,
      subtitle: message.status === 'pending' ? '待接收' : message.status === 'not_delivered' ? '未送达' : '已送达',
      history: null,
      count: 1,
      content: message.content,
    };
  }
  return null;
});
async function inspectAgent(id: string) {
  inspection.value = { kind: 'agent', id };
  emit('select', id);
  await nextTick();
  insightPanel.value?.focus({ preventScroll: true });
  insightPanel.value?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
async function inspectMessage(message: WorldCommunication) {
  inspection.value = { kind: 'message', message };
  await nextTick();
  insightPanel.value?.focus({ preventScroll: true });
  insightPanel.value?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function closeInsight() {
  const current = inspection.value;
  inspection.value = null;
  if (current?.kind === 'agent') labels.get(current.id)?.focus({ preventScroll: true });
  else encounterButton.value?.focus({ preventScroll: true });
}
const labels = new Map<string, HTMLElement>();
const seen = new Set(props.communications.map((message) => message.id));
const queue: WorldCommunication[] = [];
let scene: ReturnType<typeof createAnimalScene> | undefined;
let visibility: IntersectionObserver | undefined;
function play(message: WorldCommunication, replay = false) {
  if (!scene || failed.value) return;
  message = props.communications.find((entry) => entry.id === message.id) ?? message;
  if (message.status === 'not_delivered') {
    next();
    return;
  }
  active.value = { message, replay };
  scene.encounter(message.fromAgentId, message.toAgentId);
}
function next() {
  active.value = null;
  const message = queue.shift();
  if (message) play(message);
}
function replay(message: WorldCommunication) {
  paused.value = false;
  play(message, true);
  container.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
defineExpose({ replay });
function fail() {
  failed.value = true;
  ready.value = false;
  active.value = null;
  scene?.dispose();
  scene = undefined;
}
watch(
  () => [props.agents, props.selectedId] as const,
  () => scene?.update(props.agents, props.selectedId),
);
watch(
  () => props.communications,
  (messages) => {
    if (active.value) {
      const update = messages.find((entry) => entry.id === active.value?.message.id);
      if (update) active.value = { ...active.value, message: update };
      if (update?.status === 'not_delivered') {
        scene?.cancelEncounter();
        active.value = null;
      }
    }
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.status !== 'not_delivered') queue.push(message);
    }
    // 突发消息保留完整文字记录；动画仅排队最近的消息，不阻塞运行。
    if (queue.length > 12) queue.splice(0, queue.length - 12);
    if (!active.value && scene) next();
  },
);
watch(paused, (value) => scene?.pause(value));
onMounted(() => {
  try {
    scene = createAnimalScene(canvas.value!, {
      select: inspectAgent,
      positions: (positions) => {
        for (const point of positions) {
          const label = labels.get(point.id);
          if (!label) continue;
          label.style.left = `${point.x}%`;
          label.style.top = `${point.y}%`;
          label.style.setProperty(
            '--bubble-offset',
            `${((point.headY - point.y) / 100) * (canvas.value?.clientHeight ?? 0)}px`,
          );
        }
        ready.value = true;
      },
      encounterEnd: next,
      encounterPhase: (phase) => {
        encounterPhase.value = phase;
      },
      unavailable: fail,
    });
    scene.update(props.agents, props.selectedId);
    visibility = new IntersectionObserver(([entry]) => scene?.visibility(entry?.isIntersecting ?? false));
    visibility.observe(container.value!);
    if (queue.length) next();
  } catch {
    fail();
  }
});
onBeforeUnmount(() => {
  visibility?.disconnect();
  scene?.dispose();
  labels.clear();
});
function preview(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(-100);
}
</script>
<template>
  <div
    ref="container"
    class="animal-workroom"
    :class="{ 'scene-fallback': failed, 'scene-dense': agents.length > 4 }"
    :data-renderer="failed ? 'fallback' : ready ? 'webgl' : 'loading'"
    :data-encounter-phase="encounterPhase"
    @keydown.esc.stop="closeInsight"
  >
    <div class="workroom-toolbar">
      <div>
        <span class="room-dot" />协作工作室 <small>{{ agents.length }} 位伙伴 · 开放办公空间</small>
      </div>
      <button v-if="!failed" type="button" @click="paused = !paused">{{ paused ? '继续动画' : '暂停动画' }}</button>
    </div>
    <div class="animal-viewport" role="group" aria-label="Agent 协作场景">
      <canvas v-show="!failed" ref="canvas" aria-label="3D 小动物协作场景" role="img" />
      <div v-if="!ready && !failed" class="scene-loading">正在布置协作空间…</div>
      <div class="animal-labels" :class="{ visible: ready || failed }">
        <button
          v-for="(agent, index) in agents"
          :key="agent.id"
          :ref="
            (element) => {
              if (element) labels.set(agent.id, element as HTMLElement);
              else labels.delete(agent.id);
            }
          "
          class="world-agent"
          :class="{
            selected: selectedId === agent.id,
            'in-conversation': active && [active.message.fromAgentId, active.message.toAgentId].includes(agent.id),
          }"
          :data-activity="agent.activity"
          :aria-label="`查看 ${agent.name} 的过程`"
          :aria-pressed="selectedId === agent.id"
          :aria-expanded="inspection?.kind === 'agent' && inspection.id === agent.id"
          :aria-controls="insightId"
          type="button"
          @click="inspectAgent(agent.id)"
        >
          <div class="world-bubble">
            <small>{{ agent.bubbleKind }}</small>
            <MessageContent inert :content="preview(agent.bubble)" />
          </div>
          <span v-if="failed" class="fallback-animal" aria-hidden="true">{{ animalEmoji[index % 4] }}</span>
          <span class="animal-name" :title="agent.name">{{ agent.name }}</span>
          <span class="animal-state">{{ agent.label }}</span>
        </button>
      </div>
      <div v-if="active" class="encounter-bubble" role="status" aria-label="当前 Agent 交流">
        <button
          ref="encounterButton"
          type="button"
          aria-label="查看交流详情"
          :aria-expanded="inspection?.kind === 'message' && inspection.message.id === active.message.id"
          :aria-controls="insightId"
          @click="inspectMessage(active.message)"
        >
          <strong
            >{{ active.message.fromName }} → {{ active.message.toName
            }}<small>{{ active.replay ? '回放' : '来信' }}</small></strong
          >
          <MessageContent inert :content="active.message.content" />
        </button>
      </div>
      <section
        v-if="insight"
        :id="insightId"
        ref="insightPanel"
        class="agent-insight"
        role="region"
        aria-label="Agent 信息详情"
        tabindex="-1"
      >
        <div class="insight-heading">
          <div>
            <strong>{{ insight.title }}</strong
            ><small>{{ insight.subtitle }}</small>
          </div>
          <button type="button" aria-label="收起详情" @click="closeInsight">
            收起 <span aria-hidden="true">×</span>
          </button>
        </div>
        <div class="insight-caption">{{ insight.history ? `截至本轮 · ${insight.count} 条记录` : '协作消息' }}</div>
        <div :key="inspection?.kind === 'agent' ? inspection.id : insight.title" class="insight-content" tabindex="0">
          <AgentMessageHistory
            v-if="insight.history"
            :rounds="insight.history"
            @inspect="(runId, agentId, step) => emit('inspect', runId, agentId, step)"
          />
          <MessageContent v-else :content="insight.content" />
        </div>
      </section>
    </div>
    <div class="workroom-footer">
      <span>{{ failed ? '当前设备使用简洁角色展示' : '点击小动物或消息，展开查看详情' }}</span
      ><span>{{ active ? '正在呈现真实消息' : '呼吸 · 眨眼 · 忙碌中' }}</span>
    </div>
  </div>
</template>
<style scoped>
.animal-workroom {
  --ink: #344257;
  border: 1px solid #b8c4d4;
  border-radius: 12px;
  overflow: hidden;
  background: #f1f4f8;
  color: var(--ink);
  box-shadow: 0 16px 50px #0002;
}
.workroom-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  font-size: 13px;
  position: relative;
  z-index: 2;
}
.workroom-toolbar > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.workroom-toolbar small {
  color: #65748a;
  font-size: 11px;
  margin-left: 4px;
}
.room-dot {
  width: 7px;
  height: 7px;
  background: #608ec2;
  border-radius: 50%;
  box-shadow: 0 0 0 4px #608ec214;
}
.workroom-toolbar button {
  background: #ffffff80;
  color: #4d6482;
  border: 1px solid #cbd5e2;
  border-radius: 12px;
  font: inherit;
  font-size: 11px;
  padding: 5px 10px;
  cursor: pointer;
}
.animal-viewport {
  position: relative;
  height: clamp(460px, 62vh, 760px);
  background: radial-gradient(ellipse at 50% 20%, #fafbfe 0, #e9eef5 65%, #dbe3ed 100%);
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: pan-y;
}
.scene-loading {
  position: absolute;
  inset: 45% 0;
  text-align: center;
  color: #65748a;
  font-size: 13px;
}
.animal-labels {
  opacity: 0;
  pointer-events: none;
}
.animal-labels.visible {
  opacity: 1;
}
.world-agent {
  position: absolute;
  transform: translate(-50%, 0);
  width: 108px;
  padding: 5px 7px;
  background: #ffffffdc;
  border: 1px solid #ffffffbb;
  border-radius: 9px;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 5px 15px #4e684e12;
}
.world-agent:hover,
.world-agent.selected {
  border-color: #7498c6;
  box-shadow:
    0 0 0 3px #7498c622,
    0 5px 15px #4e684e12;
}
.animal-name {
  display: block;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.animal-state {
  display: block;
  color: #62758f;
  font-size: 10px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.world-bubble {
  position: absolute;
  bottom: calc(100% - var(--bubble-offset, -170px));
  left: 50%;
  transform: translateX(-50%);
  display: block;
  width: 112px;
  background: #fffffff5;
  padding: 5px 8px;
  text-align: left;
  border: 1px solid #ffffff;
  border-radius: 9px 9px 9px 3px;
  box-shadow: 0 5px 22px #526b8920;
  pointer-events: auto;
}
.world-bubble small {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.world-bubble :deep(.markdown) {
  display: block;
  overflow: hidden;
  line-height: 1.5;
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.world-agent:not(.selected) .world-bubble {
  opacity: 0.8;
}
.scene-dense .world-agent {
  width: 90px;
}
.scene-dense .world-bubble {
  width: 28px;
  padding: 2px 4px;
  text-align: center;
  bottom: auto;
  top: -8px;
  left: auto;
  right: -8px;
  transform: none;
}
.scene-dense .world-bubble :deep(.markdown) {
  display: none;
}
.scene-dense .world-bubble::after {
  content: '···';
  font-size: 14px;
  font-weight: 600;
  line-height: 18px;
}
.in-conversation .world-bubble {
  opacity: 0 !important;
  pointer-events: none;
}
.world-agent.in-conversation {
  width: 80px;
}
.encounter-bubble {
  position: absolute;
  z-index: 5;
  top: 5px;
  left: 50%;
  transform: translateX(-50%);
  width: min(240px, calc(100% - 24px));
  background: #f8fbfff5;
  border: 1px solid #9db6d6;
  border-radius: 11px 11px 11px 4px;
  box-shadow: 0 12px 30px #6c7a5825;
}
.encounter-bubble button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: 0;
  border-radius: inherit;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.encounter-bubble strong {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
}
.encounter-bubble small {
  color: #60799b;
  font-size: 9px;
}
.encounter-bubble :deep(.markdown) {
  display: block;
  font-size: 10px;
  line-height: 1.6;
  margin-top: 4px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.agent-insight {
  position: absolute;
  z-index: 10;
  top: 12px;
  right: 12px;
  width: min(430px, calc(100% - 24px));
  height: calc(100% - 24px);
  max-height: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid #bdccde;
  border-radius: 14px;
  box-shadow: 0 12px 35px #42583b30;
  text-align: left;
}
.insight-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid #dce3ed;
}
.insight-heading strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.insight-heading small {
  display: block;
  font-size: 10px;
  color: #65748a;
  margin-top: 5px;
}
.insight-heading button {
  flex-shrink: 0;
  padding: 3px 0 3px 6px;
  background: none;
  border: 0;
  font: inherit;
  font-size: 11px;
  color: #65748a;
  cursor: pointer;
}
.insight-heading button span {
  font-size: 16px;
  margin-left: 4px;
}
.insight-content {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 12px 16px 16px;
}
/* 详情与缩略消息复用安全 Markdown，在浅色场景中保持可读。 */
.insight-caption {
  padding: 10px 16px 0;
  color: #65748a;
  font-size: 10px;
}
.insight-content :deep(.markdown) {
  color: #344257;
  font-size: 13px;
  line-height: 1.8;
}
:deep(.markdown strong) {
  color: #24354e;
}
:deep(.markdown a) {
  color: #315f9c;
}
:deep(.markdown code) {
  color: #344257;
  background: #e9eef5;
}
:deep(.markdown pre) {
  background: #edf1f6;
  border-color: #dce3ed;
  padding: 12px;
}
:deep(.markdown pre code) {
  background: transparent;
}
:deep(.markdown blockquote) {
  color: #65748a;
  border-color: #91a8c8;
}
:deep(.markdown th),
:deep(.markdown td) {
  border-color: #d1dbe7;
}
:deep(.markdown th) {
  background: #e9eef5;
}
:deep(.markdown hr) {
  border-color: #d1dbe7;
}
.insight-content :deep(.markdown h1) {
  font-size: 19px;
}
.insight-content :deep(.markdown h2) {
  font-size: 17px;
}
.insight-content :deep(.markdown h3) {
  font-size: 15px;
}
.world-bubble :deep(.markdown),
.encounter-bubble :deep(.markdown) {
  color: var(--ink);
  max-height: 1.6em;
}
.world-bubble :deep(.markdown *),
.encounter-bubble :deep(.markdown *) {
  display: inline;
  font-size: inherit;
  line-height: inherit;
  margin: 0;
  padding: 0;
  white-space: nowrap;
  border: 0;
}
.workroom-footer {
  padding: 13px 20px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 10px;
  color: #65748a;
  border-top: 1px solid #dce3ed;
}
.scene-fallback .animal-viewport {
  height: auto;
  min-height: 240px;
}
.scene-fallback .animal-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 20px;
  justify-content: center;
}
.scene-fallback .world-agent {
  position: relative;
  left: auto !important;
  top: auto !important;
  transform: none;
  width: 140px;
}
.scene-fallback .world-bubble {
  position: static;
  transform: none;
  width: auto;
}
.fallback-animal {
  display: block;
  font-size: 72px;
  margin: 15px 0;
}
@media (max-width: 600px) {
  .animal-viewport {
    height: 360px;
  }
  .workroom-toolbar {
    padding: 14px 12px;
  }
  .workroom-toolbar small {
    display: none;
  }
  .world-agent {
    width: 88px;
    padding: 5px 4px;
  }
  .animal-name {
    font-size: 10px;
  }
  .world-bubble {
    width: 92px;
  }
  .world-agent:not(.selected) .world-bubble {
    visibility: hidden;
  }
  .scene-dense .animal-viewport {
    height: auto;
  }
  .scene-dense canvas {
    height: 340px;
  }
  .scene-dense .animal-labels {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
    padding: 10px;
  }
  .scene-dense .world-agent {
    position: relative;
    left: auto !important;
    top: auto !important;
    transform: none;
    width: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .scene-dense .animal-name,
  .scene-dense .animal-state {
    width: 100%;
  }
  .scene-dense .world-bubble {
    position: static;
    transform: none;
    order: 1;
    width: 100%;
    padding: 0;
    margin-top: 3px;
    background: none;
    border: 0;
    box-shadow: none;
    visibility: visible !important;
    opacity: 1 !important;
  }
  .scene-dense .world-bubble :deep(.markdown) {
    display: block;
  }
  .scene-dense .world-bubble::after {
    display: none;
  }
  .scene-dense .agent-insight {
    max-height: 420px;
  }
  .workroom-footer {
    padding: 12px;
  }
  .workroom-footer > span:last-child {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .animal-labels {
    transition: none;
  }
}
</style>
