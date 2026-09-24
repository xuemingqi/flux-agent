<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { z } from 'zod';
import { memorySchema, type MemoryEntry } from '@flux-agent/contracts';
import { request } from '../api/client';
import AppIcon from '../components/AppIcon.vue';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();
defineEmits<{ source: [threadId: string]; back: [] }>();
const entries = ref<MemoryEntry[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const query = ref('');
const filter = ref('all');
const editor = ref<HTMLDialogElement>();
const deletion = ref<HTMLDialogElement>();
const editing = ref<MemoryEntry>();
const deleting = ref<MemoryEntry>();
const content = ref('');
const pinned = ref(false);
const expires = ref('');
const status = ref<MemoryEntry['state']>('active');
const base = computed(() => `/workspaces/${props.workspaceId}/memories`);
const shown = computed(() => entries.value.filter((entry) => filter.value === 'all' || entry.state === filter.value));
const candidates = computed(() => entries.value.filter((entry) => entry.state === 'candidate').length);
const labels = { candidate: '待确认', active: '已启用', disabled: '已禁用' };

async function load() {
  loading.value = true;
  error.value = '';
  try {
    entries.value = await request(`${base.value}?q=${encodeURIComponent(query.value)}`, memorySchema.array());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取记忆失败。';
  } finally {
    loading.value = false;
  }
}

function edit(entry?: MemoryEntry) {
  editing.value = entry;
  content.value = entry?.content ?? '';
  pinned.value = entry?.pinned ?? false;
  status.value = entry?.state ?? 'active';
  expires.value = entry?.expiresAt
    ? new Date(Date.parse(entry.expiresAt) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : '';
  error.value = '';
  editor.value?.showModal();
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const input = {
      content: content.value,
      pinned: pinned.value,
      expiresAt: expires.value ? new Date(expires.value).toISOString() : null,
    };
    if (editing.value)
      await request(`${base.value}/${editing.value.id}`, memorySchema, {
        ...input,
        state: status.value,
        version: editing.value.version,
      });
    else await request(base.value, memorySchema, input);
    editor.value?.close();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败。';
  } finally {
    busy.value = false;
  }
}

async function setState(entry: MemoryEntry, state: MemoryEntry['state']) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await request(`${base.value}/${entry.id}`, memorySchema, {
      content: entry.content,
      pinned: entry.pinned,
      expiresAt: entry.expiresAt,
      version: entry.version,
      state,
    });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败。';
  } finally {
    busy.value = false;
  }
}

function askDelete(entry: MemoryEntry) {
  deleting.value = entry;
  error.value = '';
  deletion.value?.showModal();
}
async function remove() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await request(`${base.value}/${deleting.value.id}/delete`, z.object({ deleted: z.boolean() }), {
      version: deleting.value.version,
    });
    deletion.value?.close();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败。';
  } finally {
    busy.value = false;
  }
}
function expired(entry: MemoryEntry) {
  return !!entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now();
}
onMounted(load);
</script>

<template>
  <section class="memory-page" aria-labelledby="memory-title" :aria-busy="loading">
    <div class="memory-heading">
      <div>
        <span class="eyebrow">WORKSPACE MEMORY</span>
        <h2 id="memory-title">长期记忆</h2>
        <p>{{ workspaceName }} · 只用于此工作区中的对话</p>
      </div>
      <button class="send-button" :disabled="busy" @click="edit()"><AppIcon name="plus" :size="15" />添加记忆</button>
    </div>
    <p class="memory-intro">
      确认后的事实和约定会在相关对话中自动检索。模型提出的内容先进入待确认，置顶记忆会优先带入上下文。
    </p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <form class="memory-toolbar" @submit.prevent="load">
      <input v-model="query" aria-label="搜索记忆" placeholder="搜索约定、偏好或关键词" maxlength="500" />
      <button type="submit" :disabled="loading">搜索</button>
      <select v-model="filter" aria-label="记忆状态">
        <option value="all">全部</option>
        <option value="candidate">待确认{{ candidates ? ` (${candidates})` : '' }}</option>
        <option value="active">已启用</option>
        <option value="disabled">已禁用</option>
      </select>
    </form>
    <p v-if="loading" class="settings-description" role="status">正在读取记忆…</p>
    <div v-else-if="!shown.length" class="memory-empty">
      <AppIcon name="memory" :size="28" />
      <h3>{{ query ? '没有匹配的记忆' : '让重要的约定留在这里' }}</h3>
      <p>可以手动添加，也可以在聊天中说“请记住这个项目的约定”，再来这里确认模型提出的候选。</p>
    </div>
    <div v-else class="memory-list">
      <article v-for="entry in shown" :key="entry.id" class="memory-card">
        <div class="memory-meta">
          <span class="memory-badge" :class="entry.state">{{ expired(entry) ? '已过期' : labels[entry.state] }}</span
          ><span v-if="entry.pinned">置顶</span><span>v{{ entry.version }}</span
          ><time>{{ new Date(entry.updatedAt).toLocaleDateString() }}</time>
        </div>
        <p class="memory-content">{{ entry.content }}</p>
        <div class="memory-source">
          <span>{{ entry.source === 'agent' ? '模型提出' : '手动添加' }}</span
          ><button v-if="entry.sourceThreadId" :disabled="busy" @click="$emit('source', entry.sourceThreadId)">
            查看来源会话</button
          ><span v-if="entry.expiresAt">有效至 {{ new Date(entry.expiresAt).toLocaleString() }}</span>
        </div>
        <div class="memory-actions">
          <button
            v-if="entry.state === 'candidate'"
            class="confirm-memory"
            :disabled="busy || expired(entry)"
            @click="setState(entry, 'active')"
          >
            确认并启用</button
          ><button
            v-else
            :disabled="busy || (entry.state === 'disabled' && expired(entry))"
            @click="setState(entry, entry.state === 'active' ? 'disabled' : 'active')"
          >
            {{ entry.state === 'active' ? '禁用' : '启用' }}</button
          ><button :disabled="busy" @click="edit(entry)">编辑</button
          ><button :disabled="busy" @click="askDelete(entry)">删除</button>
        </div>
      </article>
    </div>
    <button class="memory-back" @click="$emit('back')">返回对话</button>
  </section>
  <dialog ref="editor" class="flux-dialog memory-editor" aria-labelledby="memory-edit-title">
    <form @submit.prevent="save">
      <h2 id="memory-edit-title">{{ editing ? '编辑记忆' : '添加记忆' }}</h2>
      <p>只记录值得重复使用的事实或约定，不要保存密钥和密码。</p>
      <label for="memory-content">记忆内容</label
      ><textarea id="memory-content" v-model="content" rows="5" maxlength="4000" required :disabled="busy" />
      <label class="memory-check"
        ><input v-model="pinned" type="checkbox" :disabled="busy" />置顶，优先用于此工作区对话</label
      >
      <label for="memory-expires">过期时间（留空表示不过期）</label
      ><input id="memory-expires" v-model="expires" type="datetime-local" :disabled="busy" />
      <template v-if="editing"
        ><label for="memory-state">状态</label
        ><select id="memory-state" v-model="status" :disabled="busy">
          <option value="candidate">待确认</option>
          <option value="active">已启用</option>
          <option value="disabled">已禁用</option>
        </select></template
      >
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" :disabled="busy" @click="editor?.close()">取消</button
        ><button type="submit" class="primary-action" :disabled="busy || !content.trim()">
          {{ editing ? '保存修改' : '保存并启用' }}
        </button>
      </div>
    </form>
  </dialog>
  <dialog ref="deletion" class="flux-dialog" aria-labelledby="memory-delete-title">
    <h2 id="memory-delete-title">删除这条记忆？</h2>
    <p>记忆及检索索引将删除，后续模型请求不再自动引用。原始聊天记录和已发送给模型的内容仍会保留。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <button :disabled="busy" @click="deletion?.close()">取消</button
      ><button class="primary-action" :disabled="busy" @click="remove">确认删除</button>
    </div>
  </dialog>
</template>
