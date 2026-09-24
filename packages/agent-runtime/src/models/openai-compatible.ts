import { ChatOpenAI, ChatOpenAIResponses } from '@langchain/openai';
import { CancellableOpenAI } from './cancellable-openai.js';
import { ReasoningCompletions } from './reasoning-completions.js';

export interface ModelConfiguration {
  /** 用户配置的模型窗口容量，不通过模型名称猜测供应商能力。 */
  contextWindowTokens?: number;

  /** 单次输出上限，含模型思考；0 或未配置时使用供应商默认值。 */
  maxOutputTokens?: number;
  /**
   * 服务端模型接口根地址，由调用方提供完整 API 前缀。
   */
  baseUrl: string;

  /**
   * 仅在服务端使用的供应商凭据。
   */
  apiKey: string;

  /**
   * 供应商定义的模型标识。
   */
  model: string;

  /**
   * 网关支持 stream_options 时才开启流式用量上报。
   */
  streamUsage: boolean;
}

export function createOpenAICompatibleModel(configuration: ModelConfiguration): ChatOpenAI {
  const fields = {
    model: configuration.model,
    apiKey: configuration.apiKey,
    configuration: { baseURL: configuration.baseUrl },
    useResponsesApi: false,
    streaming: true,
    streamUsage: configuration.streamUsage,
    maxRetries: 0,
    maxTokens: configuration.maxOutputTokens || -1,
  };
  // LangChain 不传 timeout 时 SDK 仍会启用默认计时器，显式绑定只响应取消的客户端。
  const client = new CancellableOpenAI({ apiKey: configuration.apiKey, baseURL: configuration.baseUrl, maxRetries: 0 });
  const completions = new ReasoningCompletions(fields);
  const responses = new ChatOpenAIResponses(fields);
  completions.client = client;
  responses.client = client;
  return new ChatOpenAI({ ...fields, completions, responses });
}
