<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  detectModelContextSchema,
  modelContextSchema,
  modelSettingsSchema,
  saveModelSettingsSchema,
  type ModelSettings,
} from '@flux-agent/contracts';
import { request } from '../api/client';

const emit = defineEmits<{ saved: [settings: ModelSettings]; back: [] }>();
const settings = ref<ModelSettings>();
const form = reactive({
  baseUrl: '',
  model: '',
  apiKey: '',
  contextWindowTokens: undefined as number | undefined,
  maxOutputTokens: 0,
});
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const detecting = ref(false);
const contextHint = ref('');
let discoveryVersion = 0;
const contextTarget = computed(() =>
  form.contextWindowTokens ? Math.floor(form.contextWindowTokens * 0.2).toLocaleString() : '',
);

watch(
  () => [form.baseUrl, form.model, form.apiKey],
  (value, previous) => {
    if (loading.value) return;
    discoveryVersion++;
    detecting.value = false;
    if (value[0] !== previous[0] || value[1] !== previous[1]) {
      form.contextWindowTokens = undefined;
      contextHint.value = '';
    }
  },
  { flush: 'sync' },
);

function cancelDiscovery() {
  discoveryVersion++;
  detecting.value = false;
  contextHint.value = '';
}

async function detectContext() {
  const input = detectModelContextSchema.safeParse(form);
  if (!input.success) return;
  const version = ++discoveryVersion;
  detecting.value = true;
  contextHint.value = '';
  try {
    const detected = await request('/settings/model/context', modelContextSchema, input.data);
    if (version !== discoveryVersion) return;
    if (detected.contextWindowTokens) {
      form.contextWindowTokens = detected.contextWindowTokens;
      contextHint.value =
        detected.source === 'provider'
          ? '已从服务商读取窗口容量，可手动调整。'
          : '已按该服务商的官方规格填写，可手动调整。';
    } else {
      contextHint.value = '未能自动获取窗口容量，请按服务商规格手动填写。';
    }
  } catch {
    if (version === discoveryVersion) contextHint.value = '窗口查询失败，请重试或手动填写。';
  } finally {
    if (version === discoveryVersion) detecting.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    settings.value = await request('/settings/model', modelSettingsSchema);
    form.baseUrl = settings.value.baseUrl;
    form.model = settings.value.model;
    form.contextWindowTokens = settings.value.contextWindowTokens || undefined;
    form.maxOutputTokens = settings.value.maxOutputTokens;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取模型配置，请重试。';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  error.value = '';
  if (!form.contextWindowTokens) await detectContext();
  if (!form.contextWindowTokens) {
    error.value = '请填写模型的上下文窗口，或点击自动获取。';
    return;
  }
  const input = saveModelSettingsSchema.safeParse(form);
  if (!input.success) {
    error.value =
      '请检查接口地址、模型名称和预算：上下文窗口需为 8192–2000000，最大输出设为 0 跟随服务商，或填写至少 256 且小于上下文窗口一半的数值。';
    return;
  }
  if (!input.data.apiKey && (!settings.value?.hasApiKey || input.data.baseUrl !== settings.value.baseUrl)) {
    error.value = '首次配置或更换接口地址时，请填写 API Key。';
    return;
  }
  saving.value = true;
  try {
    const saved = await request('/settings/model', modelSettingsSchema, input.data);
    form.apiKey = '';
    emit('saved', saved);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法保存模型配置，请重试。';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-page" aria-labelledby="model-settings-title" :aria-busy="loading || saving">
    <div class="settings-heading">
      <span class="eyebrow">MODEL CONNECTION</span>
      <h2 id="model-settings-title">{{ settings?.configured ? '模型设置' : '连接你的第一个模型' }}</h2>
      <p>
        {{
          settings?.configured
            ? '管理模型连接，保存后从下一轮对话开始生效。'
            : '还没有配置模型。填写连接信息，保存后就可以开始对话。'
        }}
      </p>
    </div>

    <p v-if="loading" class="settings-description" role="status">正在读取模型配置…</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <button v-if="!loading && !settings" class="new-chat" @click="load">重新加载</button>

    <form v-if="settings" class="settings-form" @submit.prevent="save">
      <fieldset :disabled="saving">
        <div class="provider-label"><span class="status-dot" /> OpenAI 兼容接口</div>
        <label for="model-base-url">接口地址 <span>Base URL</span></label>
        <input
          id="model-base-url"
          v-model="form.baseUrl"
          type="url"
          required
          maxlength="2048"
          placeholder="https://api.example.com/v1"
          autocomplete="url"
          aria-describedby="model-base-url-help"
          @change="detectContext"
        />
        <p id="model-base-url-help" class="field-help">
          填写服务商提供的 API 根地址，例如 https://api.example.com/v1，不要附加 /chat/completions。
        </p>

        <label for="model-name">模型名称 <span>Model</span></label>
        <input
          id="model-name"
          v-model="form.model"
          required
          maxlength="200"
          placeholder="输入服务商提供的模型名称"
          autocomplete="off"
          spellcheck="false"
          @change="detectContext"
        />

        <label for="model-api-key">API Key <span v-if="settings.hasApiKey">已保存</span></label>
        <input
          id="model-api-key"
          v-model="form.apiKey"
          type="password"
          maxlength="8192"
          autocomplete="new-password"
          :required="!settings.hasApiKey"
          :placeholder="settings.hasApiKey ? '留空保留当前密钥' : '输入 API Key'"
          aria-describedby="model-api-key-help"
          @change="!form.contextWindowTokens && detectContext()"
        />
        <p id="model-api-key-help" class="field-help">
          密钥保存在本机 SQLite 中，不会回显。更换接口地址时需要重新填写。
        </p>

        <div class="context-settings">
          <div>
            <label for="model-window">上下文窗口（tokens）</label
            ><input
              id="model-window"
              v-model.number="form.contextWindowTokens"
              type="number"
              min="8192"
              max="2000000"
              placeholder="自动获取或手动填写"
              aria-describedby="model-window-help"
              @input="cancelDiscovery"
            />
            <button type="button" class="secondary-button detect-context" :disabled="detecting" @click="detectContext">
              {{ detecting ? '正在获取…' : '自动获取' }}
            </button>
          </div>
          <div>
            <label for="model-output">最大输出（tokens）</label
            ><input
              id="model-output"
              v-model.number="form.maxOutputTokens"
              type="number"
              min="0"
              max="2000000"
              required
            />
          </div>
        </div>
        <p id="model-window-help" class="field-help" role="status">
          {{ contextHint || '填写接口和模型名称后自动获取窗口容量；不支持自动获取的服务商可手动填写。' }}
        </p>
        <p class="field-help">
          输出包括思考和正文。设为 0 时跟随服务商，并为上下文预算预留 10% 的输出空间。输入达到窗口的 90%
          时压缩；显式输出预算超过 10% 时会提前留出所需空间。 压缩后目标为窗口的 20%<span v-if="contextTarget"
            >（{{ contextTarget }} tokens）</span
          >，原记录仍然保留。
        </p>
        <div class="settings-actions">
          <button v-if="settings.configured" type="button" class="secondary-button" @click="emit('back')">
            返回对话
          </button>
          <button class="send-button" type="submit" :disabled="detecting">
            {{ saving ? '正在保存…' : '保存并开始对话' }}
          </button>
        </div>
      </fieldset>
      <p class="settings-description">配置会在重启后保留。自动获取只查询模型信息，不发送对话或消耗生成 tokens。</p>
    </form>
  </section>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 48px max(24px, calc((100% - 680px) / 2));
}
.settings-heading h2 {
  margin: 14px 0;
  font-size: 27px;
  font-weight: 550;
  letter-spacing: 1px;
}
.settings-heading p,
.settings-description {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.9;
}
.settings-form {
  margin-top: 28px;
}
fieldset {
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px;
  background: var(--surface);
  min-width: 0;
}
.provider-label {
  margin-bottom: 27px;
  color: #a6b6e0;
  font-size: 12px;
}
label {
  display: block;
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
  margin: 24px 0 10px;
}
label span {
  margin-left: 7px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
input {
  width: 100%;
  min-width: 0;
  border: 1px solid #41414b;
  background: #222227;
  border-radius: 7px;
  padding: 12px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
}
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
input::placeholder {
  color: #737380;
}
.field-help {
  font-size: 11px;
  line-height: 1.8;
  color: var(--muted);
  margin: 9px 0 0;
  overflow-wrap: anywhere;
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 30px;
}
.secondary-button {
  border: 1px solid #41414b;
  border-radius: 7px;
  background: transparent;
  padding: 9px 13px;
  font-size: 12px;
  color: #b0b0bd;
}
.detect-context {
  margin-top: 8px;
}
.settings-description {
  text-align: center;
}
@media (max-width: 760px) {
  .settings-page {
    padding: 24px;
  }
  fieldset {
    padding: 20px;
  }
}
</style>
