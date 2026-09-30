<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { z } from 'zod';
import { mcpServerSchema, mcpToolListSchema, type McpServer, type McpTool } from '@flux-agent/contracts';
import { request } from '../api/client';
import AppIcon from '../components/AppIcon.vue';
import CapabilityCatalog from '../components/CapabilityCatalog.vue';
import AppMenu from '../components/AppMenu.vue';

const servers = ref<McpServer[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const editor = ref<HTMLDialogElement>();
const deletion = ref<HTMLDialogElement>();
const toolViewer = ref<HTMLDialogElement>();
const editing = ref<McpServer>();
const deleting = ref<McpServer>();
const name = ref('');
const transport = ref<McpServer['transport']>('http');
const command = ref('');
const args = ref('[]');
const cwd = ref('');
const url = ref('');
const env = ref('');
const headers = ref('');
const enabled = ref(true);
const tools = ref<McpTool[]>([]);
const testedName = ref('');
const testing = ref('');
const query = ref('');
const filter = ref('all');
const shown = computed(() =>
  servers.value.filter(
    (server) =>
      (filter.value === 'all' || server.enabled === (filter.value === 'enabled')) &&
      `${server.name} ${server.transport} ${server.command} ${server.url}`
        .toLocaleLowerCase()
        .includes(query.value.trim().toLocaleLowerCase()),
  ),
);

async function load() {
  loading.value = true;
  try {
    servers.value = await request('/mcps', mcpServerSchema.array());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败。';
  } finally {
    loading.value = false;
  }
}

function edit(server?: McpServer) {
  editing.value = server;
  name.value = server?.name ?? '';
  transport.value = server?.transport ?? 'http';
  command.value = server?.command ?? '';
  args.value = JSON.stringify(server?.args ?? []);
  cwd.value = server?.cwd ?? '';
  url.value = server?.url ?? '';
  env.value = '';
  headers.value = '';
  enabled.value = server?.enabled ?? true;
  error.value = '';
  editor.value?.showModal();
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const data = {
      name: name.value,
      transport: transport.value,
      command: command.value,
      args: JSON.parse(args.value),
      cwd: cwd.value,
      url: url.value,
      enabled: enabled.value,
      ...(env.value.trim() ? { env: JSON.parse(env.value) } : {}),
      ...(headers.value.trim() ? { headers: JSON.parse(headers.value) } : {}),
    };
    await request(
      editing.value ? `/mcps/${editing.value.name}` : '/mcps',
      mcpServerSchema,
      editing.value ? { ...data, version: editing.value.version } : data,
    );
    // 已提交的凭据不继续留在编辑器输入中。
    env.value = '';
    headers.value = '';
    editor.value?.close();
    await load();
  } catch (cause) {
    error.value =
      cause instanceof SyntaxError
        ? '参数、环境变量和请求头需为有效 JSON。'
        : cause instanceof Error
          ? cause.message
          : '保存失败。';
  } finally {
    busy.value = false;
  }
}

async function toggle(server: McpServer) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const {
      envKeys: _envKeys,
      headerKeys: _headerKeys,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...input
    } = server;
    await request(`/mcps/${server.name}`, mcpServerSchema, { ...input, enabled: !server.enabled });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败。';
  } finally {
    busy.value = false;
  }
}

async function testConnection(server: McpServer) {
  if (busy.value) return;
  busy.value = true;
  testing.value = server.name;
  error.value = '';
  try {
    const result = await request(`/mcps/${server.name}/test`, mcpToolListSchema, {});
    testedName.value = result.server;
    tools.value = result.tools;
    toolViewer.value?.showModal();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '连接失败。';
  } finally {
    busy.value = false;
    testing.value = '';
  }
}

async function remove() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await request(`/mcps/${deleting.value.name}/delete`, z.object({ deleted: z.boolean() }), {
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
    title="MCP 管理"
    description="连接外部工具，让 Agent 在你的服务中协同工作"
    search-label="搜索 MCP"
    :total="servers.length"
    :loading="loading"
    :busy="busy"
    @refresh="
      error = '';
      load();
    "
  >
    <template #actions
      ><button class="capability-add" :disabled="busy" @click="edit()">
        添加 MCP<AppIcon name="plus" :size="16" /></button
    ></template>
    <template #notice
      ><p v-if="error && !editor?.open && !deletion?.open" class="error-banner" role="alert">{{ error }}</p></template
    >
    <div v-if="!shown.length" class="capability-empty">
      <div class="capability-empty-icon"><AppIcon name="plug" :size="28" /></div>
      <h3>{{ servers.length ? '没有匹配的 MCP' : '连接你的第一个 MCP' }}</h3>
      <p>
        {{ servers.length ? '试试其他关键词，或切换启用状态。' : '添加服务地址或本地启动命令，开始使用外部工具。' }}
      </p>
    </div>
    <div v-else class="capability-grid">
      <article
        v-for="server in shown"
        :key="server.name"
        class="capability-card"
        :class="{ 'is-disabled': !server.enabled }"
      >
        <div class="capability-avatar mcp-avatar" :class="server.transport">
          <AppIcon :name="server.transport === 'stdio' ? 'terminal' : 'plug'" :size="25" />
        </div>
        <div class="capability-info">
          <h3>{{ server.name }}</h3>
          <p
            class="capability-description"
            :title="server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url"
          >
            {{ server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url }}
          </p>
          <div class="capability-meta">
            <span class="capability-state" :class="{ enabled: server.enabled }">{{
              server.enabled ? '已启用' : '已禁用'
            }}</span>
            <span>{{
              server.transport === 'http' ? 'Streamable HTTP' : server.transport === 'stdio' ? '本地 stdio' : 'SSE'
            }}</span
            ><span>v{{ server.version }}</span>
          </div>
        </div>
        <AppMenu :label="`MCP ${server.name} 的更多操作`" :disabled="busy">
          <button :disabled="busy" @click="edit(server)"><AppIcon name="edit" :size="16" />编辑</button>
          <button :disabled="busy || !server.enabled" @click="testConnection(server)">
            <AppIcon name="refresh" :size="16" />{{ testing === server.name ? '连接中…' : '测试连接' }}
          </button>
          <button :disabled="busy" @click="toggle(server)">
            <AppIcon :name="server.enabled ? 'pause' : 'check'" :size="16" />{{ server.enabled ? '禁用' : '启用' }}
          </button>
          <div class="capability-menu-divider" />
          <button
            class="danger"
            :disabled="busy"
            @click="
              deleting = server;
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
  <dialog ref="editor" class="flux-dialog capability-editor capability-form" aria-labelledby="mcp-edit-title">
    <form @submit.prevent="save">
      <header class="capability-dialog-heading">
        <div class="capability-avatar mcp-avatar"><AppIcon name="plug" :size="25" /></div>
        <div>
          <h2 id="mcp-edit-title">{{ editing ? '编辑 MCP' : '添加 MCP' }}</h2>
          <p>连接你的服务，让 Agent 使用外部工具。</p>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭 MCP 编辑器"
          :disabled="busy"
          @click="editor?.close()"
        >
          <AppIcon name="close" />
        </button>
      </header>
      <div class="capability-dialog-body">
        <div class="capability-field">
          <label for="mcp-name">MCP 名称</label>
          <input
            id="mcp-name"
            v-model="name"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxlength="64"
            required
            placeholder="例如 my-tools"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy || !!editing"
          />
        </div>
        <fieldset class="capability-transport" :disabled="busy">
          <legend>连接方式</legend>
          <div>
            <label :class="{ selected: transport === 'http' }">
              <input v-model="transport" type="radio" name="mcp-transport" value="http" aria-label="Streamable HTTP" />
              <AppIcon name="plug" :size="19" /><strong>HTTP</strong><small>远程服务</small>
            </label>
            <label :class="{ selected: transport === 'stdio' }">
              <input v-model="transport" type="radio" name="mcp-transport" value="stdio" aria-label="本地 stdio" />
              <AppIcon name="terminal" :size="19" /><strong>stdio</strong><small>本地进程</small>
            </label>
            <label :class="{ selected: transport === 'sse' }">
              <input v-model="transport" type="radio" name="mcp-transport" value="sse" aria-label="SSE" />
              <AppIcon name="refresh" :size="19" /><strong>SSE</strong><small>事件流连接</small>
            </label>
          </div>
        </fieldset>
        <template v-if="transport === 'stdio'">
          <div class="capability-field">
            <label for="mcp-command">启动命令</label>
            <input
              id="mcp-command"
              v-model="command"
              placeholder="例如 npx 或可执行文件路径"
              required
              :disabled="busy"
              spellcheck="false"
            />
          </div>
          <div class="capability-field">
            <div class="capability-code-heading"><label for="mcp-args">参数（JSON 数组）</label><span>JSON</span></div>
            <textarea
              id="mcp-args"
              v-model="args"
              class="capability-code-input"
              rows="2"
              placeholder='["-y", "@example/mcp-server"]'
              :disabled="busy"
              spellcheck="false"
            />
            <p class="capability-field-help">测试连接会启动此进程，Agent 调用需要完全权限。</p>
          </div>
          <details class="capability-advanced" :open="!!editing?.cwd || !!editing?.envKeys.length">
            <summary>高级配置<AppIcon name="down" :size="15" /></summary>
            <div class="capability-field">
              <label for="mcp-cwd">工作目录（可选绝对路径）</label
              ><input id="mcp-cwd" v-model="cwd" placeholder="留空使用默认工作目录" :disabled="busy" />
            </div>
            <div class="capability-field">
              <label for="mcp-env">环境变量（JSON 对象）</label>
              <textarea
                id="mcp-env"
                v-model="env"
                class="capability-code-input"
                rows="3"
                placeholder='{"API_KEY": "..."}'
                :disabled="busy"
                autocomplete="off"
                spellcheck="false"
              />
              <p v-if="editing?.envKeys.length" class="capability-field-help">
                已保存：{{ editing.envKeys.join('、') }}。留空保留，填写 {} 清除。
              </p>
            </div>
          </details>
        </template>
        <template v-else>
          <div class="capability-field">
            <label for="mcp-url">服务地址</label>
            <input
              id="mcp-url"
              v-model="url"
              type="url"
              placeholder="https://example.com/mcp"
              required
              :disabled="busy"
              spellcheck="false"
            />
            <p class="capability-field-help">填写 MCP 服务提供的{{ transport === 'sse' ? ' SSE' : '' }}连接地址。</p>
          </div>
          <details class="capability-advanced" :open="!!editing?.headerKeys.length">
            <summary>高级配置<AppIcon name="down" :size="15" /></summary>
            <div class="capability-field">
              <label for="mcp-headers">请求头（JSON 对象）</label>
              <textarea
                id="mcp-headers"
                v-model="headers"
                class="capability-code-input"
                rows="3"
                placeholder='{"Authorization": "Bearer ..."}'
                :disabled="busy"
                autocomplete="off"
                spellcheck="false"
              />
              <p v-if="editing?.headerKeys.length" class="capability-field-help">
                已保存：{{ editing.headerKeys.join('、') }}。留空保留，填写 {} 清除。
              </p>
              <p v-else class="capability-field-help">服务需要身份验证时，在这里配置请求头。</p>
            </div>
          </details>
        </template>
        <label class="capability-switch">
          <span><strong>启用 MCP</strong><small>允许 Agent 发现并调用此服务的工具。</small></span>
          <input v-model="enabled" type="checkbox" role="switch" aria-label="启用 MCP" :disabled="busy" />
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </div>
      <footer class="dialog-actions capability-dialog-actions">
        <button type="button" :disabled="busy" @click="editor?.close()">取消</button
        ><button type="submit" class="primary-action" :disabled="busy">{{ busy ? '保存中…' : '保存 MCP' }}</button>
      </footer>
    </form>
  </dialog>
  <dialog ref="deletion" class="flux-dialog" aria-labelledby="mcp-delete-title">
    <h2 id="mcp-delete-title">删除 {{ deleting?.name }}？</h2>
    <p>配置及保存的凭据将删除，后续请求不能调用此服务。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <button :disabled="busy" @click="deletion?.close()">取消</button
      ><button class="primary-action" :disabled="busy" @click="remove">确认删除</button>
    </div>
  </dialog>
  <dialog ref="toolViewer" class="flux-dialog capability-editor" aria-labelledby="mcp-tools-title">
    <h2 id="mcp-tools-title">{{ testedName }} · 连接成功</h2>
    <p>共 {{ tools.length }} 个工具</p>
    <details v-for="tool in tools" :key="tool.name" class="capability-tool">
      <summary>{{ tool.name }}</summary>
      <p>{{ tool.description }}</p>
      <pre>{{ JSON.stringify(tool.inputSchema, null, 2) }}</pre>
    </details>
    <div class="dialog-actions"><button @click="toolViewer?.close()">关闭</button></div>
  </dialog>
</template>
