import type { AgentRuntime, ModelConfiguration } from '@flux-agent/agent-runtime';
import type { DetectModelContext, ModelSettings, SaveModelSettings } from '@flux-agent/contracts';
import { ApplicationError } from '../api/application-error.js';
import type { ModelSettingsStore } from './model-settings-store.js';
import { discoverModelContext } from './model-context.js';

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
    private readonly discoverContext = discoverModelContext,
  ) {
    this.configuration = { maxOutputTokens: 0, ...defaults };
  }

  /**
   * 优先加载数据库配置；首次启动时将完整环境变量配置导入数据库。
   */
  async initialize(): Promise<void> {
    const saved = this.store.load();
    if (saved) this.configuration = { ...this.configuration, ...saved };
    if (!this.configuration.contextWindowTokens && this.configuration.model && this.configuration.apiKey) {
      const detected = await this.discoverContext(this.configuration);
      this.configuration.contextWindowTokens = detected.contextWindowTokens ?? undefined;
    }
    if (!this.getSettings().configured) return;
    if (!saved) {
      const { baseUrl, model, apiKey } = this.configuration;
      this.store.save({
        baseUrl,
        model,
        apiKey,
        contextWindowTokens: this.configuration.contextWindowTokens,
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
      configured: Boolean(model && apiKey && this.configuration.contextWindowTokens),
      contextWindowTokens: this.configuration.contextWindowTokens ?? 0,
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
   * 为设置页读取容量；仅相同端点可以复用已保存的密钥，不修改配置或运行实例。
   */
  async detectContext(input: DetectModelContext) {
    const apiKey = input.apiKey || (input.baseUrl === this.configuration.baseUrl ? this.configuration.apiKey : '');
    return this.discoverContext({ ...input, apiKey });
  }

  /**
   * 先原子保存，再切换新运行使用的实例；空密钥仅在接口地址未改变时保留原密钥。
   */
  async save(input: SaveModelSettings): Promise<ModelSettings> {
    if (this.saving) throw new ApplicationError('SETTINGS_BUSY', '模型配置正在保存，请稍后重试。', 409);
    const apiKey = input.apiKey || (input.baseUrl === this.configuration.baseUrl ? this.configuration.apiKey : '');
    if (!apiKey) throw new ApplicationError('API_KEY_REQUIRED', '首次配置或更换接口地址时，请填写 API Key。');
    this.saving = true;
    try {
      const contextWindowTokens = input.contextWindowTokens ?? (await this.detectContext(input)).contextWindowTokens;
      if (!contextWindowTokens)
        throw new ApplicationError('CONTEXT_WINDOW_REQUIRED', '无法自动获取模型窗口，请按服务商规格填写上下文窗口。');
      const configuration = { ...this.configuration, ...input, apiKey, contextWindowTokens };
      if ((configuration.maxOutputTokens ?? 0) >= contextWindowTokens / 2)
        throw new ApplicationError('INVALID_CONTEXT_BUDGET', '最大输出须小于上下文窗口的一半。');
      const runtime = this.createRuntime(configuration);
      try {
        this.store.save({ ...input, apiKey, contextWindowTokens });
      } catch {
        throw new ApplicationError('SETTINGS_SAVE_FAILED', '无法保存模型配置，请检查本地数据目录的写入权限。', 503);
      }
      this.configuration = configuration;
      this.runtime = runtime;
      return this.getSettings();
    } finally {
      this.saving = false;
    }
  }
}
