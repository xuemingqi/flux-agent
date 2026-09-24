import type { AgentRuntime, ModelConfiguration } from '@flux-agent/agent-runtime';
import type { ModelSettings, SaveModelSettings } from '@flux-agent/contracts';
import { ApplicationError } from '../api/application-error.js';
import type { ModelSettingsStore } from './model-settings-store.js';

/**
 * 模型配置和运行实例的唯一所有者；只向浏览器返回不含密钥的设置摘要。
 */
export class ModelSettingsService {
  private configuration: ModelConfiguration;

  private runtime: AgentRuntime | null = null;

  private saving = false;

  constructor(
    private readonly store: ModelSettingsStore,
    defaults: ModelConfiguration,
    private readonly createRuntime: (configuration: ModelConfiguration) => AgentRuntime,
  ) {
    this.configuration = { contextWindowTokens: 32768, maxOutputTokens: 0, ...defaults };
  }

  /**
   * 优先加载数据库配置；首次启动时将完整环境变量配置导入数据库。
   */
  async initialize(): Promise<void> {
    const saved = this.store.load();
    if (saved) this.configuration = { ...this.configuration, ...saved };
    if (!this.getSettings().configured) return;
    if (!saved) {
      const { baseUrl, model, apiKey } = this.configuration;
      this.store.save({
        baseUrl,
        model,
        apiKey,
        contextWindowTokens: this.configuration.contextWindowTokens ?? 32768,
        maxOutputTokens: this.configuration.maxOutputTokens ?? 0,
      });
    }
    this.runtime = this.createRuntime(this.configuration);
  }

  /**
   * 返回配置状态，永远不返回已保存的 API Key。
   */
  getSettings(): ModelSettings {
    const { baseUrl, model, apiKey } = this.configuration;
    return {
      baseUrl,
      model,
      hasApiKey: Boolean(apiKey),
      configured: Boolean(model && apiKey),
      contextWindowTokens: this.configuration.contextWindowTokens ?? 32768,
      maxOutputTokens: this.configuration.maxOutputTokens ?? 0,
    };
  }

  /**
   * 每轮开始时获取实例快照；后续保存不会改变已经开始的运行。
   */
  getRuntime(): AgentRuntime | null {
    return this.runtime;
  }

  /**
   * 先原子保存，再切换新运行使用的实例；空密钥仅在接口地址未改变时保留原密钥。
   */
  async save(input: SaveModelSettings): Promise<ModelSettings> {
    if (this.saving) throw new ApplicationError('SETTINGS_BUSY', '模型配置正在保存，请稍后重试。', 409);
    const apiKey = input.apiKey || (input.baseUrl === this.configuration.baseUrl ? this.configuration.apiKey : '');
    if (!apiKey) throw new ApplicationError('API_KEY_REQUIRED', '首次配置或更换接口地址时，请填写 API Key。');
    const configuration = { ...this.configuration, ...input, apiKey };
    if ((configuration.maxOutputTokens ?? 0) >= (configuration.contextWindowTokens ?? 32768) / 2)
      throw new ApplicationError('INVALID_CONTEXT_BUDGET', '最大输出须小于上下文窗口的一半。');
    const runtime = this.createRuntime(configuration);
    this.saving = true;
    try {
      this.store.save({
        ...input,
        apiKey,
        contextWindowTokens: configuration.contextWindowTokens ?? 32768,
        maxOutputTokens: configuration.maxOutputTokens ?? 0,
      });
      this.configuration = configuration;
      this.runtime = runtime;
      return this.getSettings();
    } catch {
      throw new ApplicationError('SETTINGS_SAVE_FAILED', '无法保存模型配置，请检查本地数据目录的写入权限。', 503);
    } finally {
      this.saving = false;
    }
  }
}
