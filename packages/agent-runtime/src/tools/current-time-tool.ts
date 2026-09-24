import { tool } from '@langchain/core/tools';

export const currentTimeTool = tool(
  () => {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return JSON.stringify({ iso: now.toISOString(), timeZone, localTime: now.toLocaleString('zh-CN', { timeZone }) });
  },
  {
    name: 'get_current_time',
    description: '读取服务器的当前日期、时间和时区。只读操作，无需参数。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
  },
);
