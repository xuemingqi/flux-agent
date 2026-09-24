import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk } from '@langchain/core/outputs';

/**
 * 兼容要求回传 reasoning_content 的模型。当前 LangChain 转换器只读取该字段，发送时会丢失。
 * 原始消息按异步请求隔离，避免并发子 Agent 在共享模型实例上相互覆盖。
 */
export class ReasoningCompletions extends ChatOpenAICompletions {
  private readonly sourceMessages = new AsyncLocalStorage<BaseMessage[]>();

  override _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], manager?: CallbackManagerForLLMRun) {
    return this.sourceMessages.run(messages, () => super._generate(messages, options, manager));
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    manager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const stream = super._streamResponseChunks(messages, options, manager);
    try {
      while (true) {
        const next = await this.sourceMessages.run(messages, () => stream.next());
        if (next.done) return;
        // 流式结束原因原本只在 generationInfo 中；图状态只保留 message，需一并透传。
        const finishReason = next.value.generationInfo?.finish_reason;
        if (typeof finishReason === 'string')
          next.value.message.response_metadata = {
            ...next.value.message.response_metadata,
            finish_reason: finishReason,
          };
        yield next.value;
      }
    } finally {
      await stream.return(undefined);
    }
  }

  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: OpenAI.RequestOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: OpenAI.RequestOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  override completionWithRetry(request: OpenAI.Chat.ChatCompletionCreateParams, options?: OpenAI.RequestOptions) {
    const source = this.sourceMessages.getStore();
    const messages = request.messages.map((message, index) => {
      const reasoning = source?.[index]?.additional_kwargs.reasoning_content;
      return message.role === 'assistant' && typeof reasoning === 'string'
        ? { ...message, reasoning_content: reasoning }
        : message;
    });
    return request.stream
      ? super.completionWithRetry({ ...request, messages }, options)
      : super.completionWithRetry({ ...request, messages, stream: false }, options);
  }
}
