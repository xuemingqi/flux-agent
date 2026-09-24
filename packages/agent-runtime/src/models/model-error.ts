import type { ApiError } from '@flux-agent/contracts';
import { isContextOverflow } from '../context/context-compressor.js';
import { ModelOutputLimitError } from './model-output-limit-error.js';

/**
 * 主、子 Agent 共用安全的模型错误分类，不把供应商原文中的凭据或地址写入会话。
 */
export function describeModelError(error: unknown): ApiError {
  if (error instanceof ModelOutputLimitError) return { code: 'MODEL_OUTPUT_LIMIT', message: error.message };
  if (isContextOverflow(error))
    return { code: 'MODEL_CONTEXT_LIMIT', message: '模型上下文窗口不足，压缩后仍无法容纳本次输入。' };
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  const message = error instanceof Error ? error.message : '';
  if (status === 401 || status === 403)
    return { code: 'MODEL_AUTH', message: `模型鉴权失败（HTTP ${status}），请检查共用的 API Key 和模型权限。` };
  if (/missing credentials|missing.*api.?key|OPENAI_API_KEY.*(?:missing|not set)/i.test(message))
    return { code: 'MODEL_KEY_MISSING', message: '模型客户端未获得 API Key，请检查模型配置的加载。' };
  if (status === 429) return { code: 'MODEL_RATE_LIMIT', message: '模型请求受限或额度不足（HTTP 429），请稍后重试。' };
  if (status === 400 && /reasoning_content/i.test(message))
    return {
      code: 'MODEL_REASONING_PROTOCOL',
      message: '模型拒绝了思考上下文格式（HTTP 400），需要检查模型协议兼容。',
    };
  if (typeof status === 'number')
    return { code: 'MODEL_ERROR', message: `模型服务返回 HTTP ${status}，请检查接口兼容性或服务状态。` };
  return { code: 'MODEL_ERROR', message: '模型调用失败，请检查模型名称、接口地址和网络后重试。' };
}
