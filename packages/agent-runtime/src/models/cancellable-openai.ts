import OpenAI from 'openai';
import { Agent, fetch as transportFetch } from 'undici';

// 仅此模型适配器使用，不修改应用全局 dispatcher；空闲连接照常释放。
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 0 } });

/**
 * 兼容接口可能长时间等待首包或工具后的回答，只按用户/运行取消信号中止。
 * SDK 的 timeout=0 会立即超时，因此替换请求发送钩子，并关闭底层响应等待计时器。
 */
export class CancellableOpenAI extends OpenAI {
  override async fetchWithTimeout(
    url: RequestInfo,
    init: RequestInit | undefined,
    _milliseconds: number,
    controller: AbortController,
  ): Promise<Response> {
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return transportFetch(
      url as string,
      { ...init, signal, dispatcher } as Parameters<typeof transportFetch>[1],
    ) as unknown as Promise<Response>;
  }
}
