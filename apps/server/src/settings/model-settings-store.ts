import type { SaveModelSettings } from '@flux-agent/contracts';

/**
 * 模型凭据的持久化边界；服务和 API 不依赖具体数据库表。
 */
export interface ModelSettingsStore {
  load(): SaveModelSettings | undefined;
  save(settings: SaveModelSettings): void;
}
