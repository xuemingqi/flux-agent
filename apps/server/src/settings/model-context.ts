import { z } from 'zod';
import type { DetectModelContext, ModelContext } from '@flux-agent/contracts';

const capacitySchema = z.number().int().min(8192).max(2_000_000);
const modelListSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * 优先使用当前服务商的模型元数据，不把同名第三方模型当作官方模型。
 * DeepSeek 的 /models 不返回容量，官方端点使用已核实规格作为补充。
 */
export async function discoverModelContext(input: DetectModelContext, fetcher = fetch): Promise<ModelContext> {
  const endpoint = new URL(input.baseUrl);
  try {
    const response = await fetcher(`${input.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      // 凭据只发送到用户配置的端点，不跟随重定向到其他服务。
      redirect: 'error',
    });
    if (response.ok) {
      const result = modelListSchema.safeParse(await response.json());
      const model = result.success ? result.data.data.find((entry) => entry.id === input.model) : undefined;
      const provider = model?.top_provider;
      const candidates = [
        provider && typeof provider === 'object' && 'context_length' in provider ? provider.context_length : undefined,
        model?.context_length,
        model?.context_window,
        model?.context_window_tokens,
        model?.max_model_len,
      ];
      const capacities = candidates.flatMap((value) => {
        const result = capacitySchema.safeParse(value);
        return result.success ? [result.data] : [];
      });
      if (capacities.length) return { contextWindowTokens: Math.min(...capacities), source: 'provider' };
    } else {
      await response.body?.cancel();
    }
  } catch {
    // 网络错误、无容量字段和不支持 /models 均允许手动配置；供应商原始错误不能暴露凭据。
  }
  // https://api-docs.deepseek.com/quick_start/pricing/ (2026-09-24)
  // 官方集成容量：https://api-docs.deepseek.com/quick_start/agent_integrations/crush/
  if (
    endpoint.origin === 'https://api.deepseek.com' &&
    ['/', '/v1', '/v1/'].includes(endpoint.pathname) &&
    ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(input.model)
  ) {
    return { contextWindowTokens: 1_048_576, source: 'official' };
  }
  return { contextWindowTokens: null, source: null };
}
