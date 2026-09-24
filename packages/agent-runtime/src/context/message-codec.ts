import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ModelMessage } from '@flux-agent/contracts';

export function decodeMessage(message: ModelMessage): BaseMessage {
  if (message.role === 'user')
    return new HumanMessage({
      // 图状态按消息 ID 合并，批量插话必须各有独立标识，避免同一节点内相互覆盖。
      ...(message.steeringId ? { id: `steering:${message.steeringId}` } : {}),
      content: message.content,
      additional_kwargs: message.steeringId ? { fluxSteeringId: message.steeringId } : {},
    });
  if (message.role === 'tool')
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
      status: message.status,
    });
  return new AIMessage({
    content: message.content,
    tool_calls: message.toolCalls?.map((call) => ({ ...call, type: 'tool_call' as const })),
    // 空字符串表示模型明确返回了空思考；工具后续请求仍需回传，不能把它变成缺失字段。
    additional_kwargs: typeof message.reasoning === 'string' ? { reasoning_content: message.reasoning } : {},
    response_metadata: message.finishReason ? { finish_reason: message.finishReason } : {},
  });
}

/**
 * 仅存放已支持的文本及工具消息，供应商内部响应和鉴权元数据不落入历史。
 */
export function encodeMessages(messages: BaseMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.contentBlocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
    if (isHumanMessage(message)) {
      const steeringId = message.additional_kwargs.fluxSteeringId;
      return [{ role: 'user', content, ...(typeof steeringId === 'string' ? { steeringId } : {}) }];
    }
    if (isToolMessage(message))
      return [
        {
          role: 'tool',
          content,
          toolCallId: message.tool_call_id,
          ...(message.name ? { name: message.name } : {}),
          ...(message.status ? { status: message.status } : {}),
        },
      ];
    if (!isAIMessage(message)) return [];
    const reasoning = message.additional_kwargs.reasoning_content;
    return [
      {
        role: 'assistant',
        content,
        ...(typeof reasoning === 'string' ? { reasoning } : {}),
        ...(typeof message.response_metadata.finish_reason === 'string'
          ? { finishReason: message.response_metadata.finish_reason }
          : {}),
        ...(message.tool_calls?.length
          ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id ?? '', name: call.name, args: call.args })) }
          : {}),
      },
    ];
  });
}
