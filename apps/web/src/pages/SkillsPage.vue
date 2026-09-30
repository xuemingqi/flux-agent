<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { z } from 'zod';
import {
  skillSchema,
  skillSummarySchema,
  skillExportSchema,
  type Skill,
  type SkillSummary,
} from '@flux-agent/contracts';
import { request } from '../api/client';
import AppIcon from '../components/AppIcon.vue';
import CapabilityCatalog from '../components/CapabilityCatalog.vue';
import AppMenu from '../components/AppMenu.vue';

const skills = ref<SkillSummary[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const editor = ref<HTMLDialogElement>();
const deletion = ref<HTMLDialogElement>();
const upload = ref<HTMLInputElement>();
const editing = ref<Skill>();
const deleting = ref<SkillSummary>();
const name = ref('');
const markdown = ref('');
const files = ref<Skill['files']>([]);
const enabled = ref(true);
const query = ref('');
const filter = ref('all');
const shown = computed(() =>
  skills.value.filter(
    (skill) =>
      (filter.value === 'all' || skill.enabled === (filter.value === 'enabled')) &&
      `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const template =
  '---\nname: new-skill\ndescription: 描述此 Skill 的用途和适用场景\n---\n\n# 操作步骤\n\n在这里填写 Agent 应遵循的操作步骤。\n';

async function load() {
  loading.value = true;
  try {
    skills.value = await request('/skills', skillSummarySchema.array());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败。';
  } finally {
    loading.value = false;
  }
}

async function edit(skill?: SkillSummary) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    editing.value = skill ? await request(`/skills/${skill.name}`, skillSchema) : undefined;
    name.value = editing.value?.name ?? 'new-skill';
    markdown.value = editing.value?.markdown ?? template;
    files.value = editing.value?.files ?? [];
    enabled.value = editing.value?.enabled ?? true;
    editor.value?.showModal();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败。';
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const data = {
      name: name.value,
      markdown: editing.value ? markdown.value : markdown.value.replace(/^name:.*$/m, `name: ${name.value}`),
      files: files.value,
      enabled: enabled.value,
    };
    await request(
      editing.value ? `/skills/${editing.value.name}` : '/skills',
      skillSchema,
      editing.value ? { ...data, version: editing.value.version } : data,
    );
    editor.value?.close();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败。';
  } finally {
    busy.value = false;
  }
}

async function toggle(skill: SkillSummary) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const entry = await request(`/skills/${skill.name}`, skillSchema);
    const { description: _description, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = entry;
    await request(`/skills/${skill.name}`, skillSchema, { ...input, enabled: !entry.enabled });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败。';
  } finally {
    busy.value = false;
  }
}

async function base64(file: File, maximum = 10_000_000) {
  if (file.size > maximum) throw new Error(`文件不能超过 ${maximum / 1_000_000} MB。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await request('/skills/import', skillSchema, { filename: file.name, content: await base64(file, 21_000_000) });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导入失败。';
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  busy.value = true;
  error.value = '';
  try {
    const additions = await Promise.all(
      [...(input.files ?? [])].map(async (file) => ({ path: file.name, content: await base64(file) })),
    );
    if (additions.some((file) => files.value.some((existing) => existing.path === file.path)))
      throw new Error('同名资源已存在，请先移除再添加。');
    files.value.push(...additions);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取资源失败。';
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function exportFile(skill: SkillSummary) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await request(`/skills/${skill.name}/export`, skillExportSchema);
    const bytes = Uint8Array.from(atob(result.content), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导出失败。';
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await request(`/skills/${deleting.value.name}/delete`, z.object({ deleted: z.boolean() }), {
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
onMounted(load);
</script>

<template>
  <CapabilityCatalog
    v-model:query="query"
    v-model:filter="filter"
    title="Skill 管理"
    description="为 Agent 添加技能，让熟悉的工作方法随时可用"
    search-label="搜索技能"
    :total="skills.length"
    :loading="loading"
    :busy="busy"
    @refresh="
      error = '';
      load();
    "
  >
    <template #actions>
      <AppMenu label="添加 Skill" :disabled="busy" trigger-class="capability-add">
        <template #trigger>添加<AppIcon name="down" :size="15" /></template>
        <button :disabled="busy" @click="edit()"><AppIcon name="plus" :size="16" />创建 Skill</button>
        <button :disabled="busy" @click="upload?.click()"><AppIcon name="import" :size="16" />导入 Skill</button>
      </AppMenu>
    </template>
    <template #notice>
      <input ref="upload" type="file" accept=".zip,.md" aria-label="导入 Skill 文件" hidden @change="importFile" />
      <p v-if="error && !editor?.open && !deletion?.open" class="error-banner" role="alert">{{ error }}</p>
    </template>
    <div v-if="!shown.length" class="capability-empty">
      <div class="capability-empty-icon"><AppIcon name="skill" :size="28" /></div>
      <h3>{{ skills.length ? '没有匹配的技能' : '添加你的第一个 Skill' }}</h3>
      <p>
        {{ skills.length ? '试试其他关键词，或切换启用状态。' : '创建自己的操作步骤，或从 SKILL.md 和 ZIP 包导入。' }}
      </p>
    </div>
    <div v-else class="capability-grid">
      <article
        v-for="skill in shown"
        :key="skill.name"
        class="capability-card"
        :class="{ 'is-disabled': !skill.enabled }"
      >
        <div class="capability-avatar skill-avatar"><AppIcon name="skill" :size="26" /></div>
        <div class="capability-info">
          <h3>{{ skill.name }}</h3>
          <p class="capability-description" :title="skill.description">{{ skill.description }}</p>
          <div class="capability-meta">
            <span class="capability-state" :class="{ enabled: skill.enabled }">{{
              skill.enabled ? '已启用' : '已禁用'
            }}</span>
            <span>v{{ skill.version }}</span
            ><span>{{ skill.fileCount }} 个文件</span>
          </div>
        </div>
        <AppMenu :label="`Skill ${skill.name} 的更多操作`" :disabled="busy">
          <button :disabled="busy" @click="edit(skill)"><AppIcon name="edit" :size="16" />编辑</button>
          <button :disabled="busy" @click="exportFile(skill)"><AppIcon name="export" :size="16" />导出</button>
          <button :disabled="busy" @click="toggle(skill)">
            <AppIcon :name="skill.enabled ? 'pause' : 'check'" :size="16" />{{ skill.enabled ? '禁用' : '启用' }}
          </button>
          <div class="capability-menu-divider" />
          <button
            class="danger"
            :disabled="busy"
            @click="
              deleting = skill;
              error = '';
              deletion?.showModal();
            "
          >
            <AppIcon name="trash" :size="16" />删除
          </button>
        </AppMenu>
      </article>
    </div>
  </CapabilityCatalog>
  <dialog ref="editor" class="flux-dialog capability-editor capability-form" aria-labelledby="skill-edit-title">
    <form @submit.prevent="save">
      <header class="capability-dialog-heading">
        <div class="capability-avatar skill-avatar"><AppIcon name="skill" :size="25" /></div>
        <div>
          <h2 id="skill-edit-title">{{ editing ? '编辑 Skill' : '创建 Skill' }}</h2>
          <p>把熟悉的工作方法，变成 Agent 可复用的技能。</p>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭 Skill 编辑器"
          :disabled="busy"
          @click="editor?.close()"
        >
          <AppIcon name="close" />
        </button>
      </header>
      <div class="capability-dialog-body">
        <div class="capability-field">
          <label for="skill-name">Skill 名称</label>
          <input
            id="skill-name"
            v-model="name"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxlength="64"
            required
            placeholder="例如 code-review"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="skill-name-help"
            :disabled="busy || !!editing"
          />
          <p id="skill-name-help" class="capability-field-help">使用小写字母、数字和连字符。</p>
        </div>
        <div class="capability-field">
          <div class="capability-code-heading">
            <label for="skill-markdown">操作说明</label><span>SKILL.md · Markdown</span>
          </div>
          <textarea
            id="skill-markdown"
            v-model="markdown"
            class="capability-code-input"
            aria-label="SKILL.md 内容"
            rows="10"
            maxlength="128000"
            required
            :disabled="busy"
            spellcheck="false"
            aria-describedby="skill-markdown-help"
          />
          <p id="skill-markdown-help" class="capability-field-help">
            保留 YAML 中的 name 和 description，在正文中编写操作步骤。
          </p>
        </div>
        <section class="capability-files" aria-label="资源文件">
          <div class="capability-files-heading">
            <span
              >资源文件 <small>{{ files.length }}</small></span
            >
            <label class="capability-upload" :class="{ disabled: busy }">
              <AppIcon name="plus" :size="14" />添加文件
              <input type="file" multiple hidden :disabled="busy" @change="addFiles" />
            </label>
          </div>
          <p v-if="!files.length" class="capability-files-empty">可添加脚本、模板或参考资料。</p>
          <div v-for="file in files" :key="file.path" class="capability-file">
            <AppIcon name="file" :size="16" /><code>{{ file.path }}</code>
            <button type="button" :disabled="busy" @click="files = files.filter((item) => item.path !== file.path)">
              移除
            </button>
          </div>
        </section>
        <label class="capability-switch">
          <span><strong>启用 Skill</strong><small>在对话中允许 Agent 按需使用此技能。</small></span>
          <input v-model="enabled" type="checkbox" role="switch" aria-label="启用 Skill" :disabled="busy" />
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </div>
      <footer class="dialog-actions capability-dialog-actions">
        <button type="button" :disabled="busy" @click="editor?.close()">取消</button
        ><button type="submit" class="primary-action" :disabled="busy">{{ busy ? '保存中…' : '保存 Skill' }}</button>
      </footer>
    </form>
  </dialog>
  <dialog ref="deletion" class="flux-dialog" aria-labelledby="skill-delete-title">
    <h2 id="skill-delete-title">删除 {{ deleting?.name }}？</h2>
    <p>Skill 及附带资源将删除，后续请求不再加载。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <button :disabled="busy" @click="deletion?.close()">取消</button
      ><button class="primary-action" :disabled="busy" @click="remove">确认删除</button>
    </div>
  </dialog>
</template>
