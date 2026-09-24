import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch as transportFetch } from 'undici';
import { CancellableOpenAI } from '../src/models/cancellable-openai.js';
import { createOpenAICompatibleModel } from '../src/models/openai-compatible.js';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import { ModelOutputLimitError } from '../src/models/model-output-limit-error.js';
import type { AgentTask } from '@flux-agent/contracts';
import { ContextCompressor } from '../src/context/context-compressor.js';

vi.mock('undici', async (original) => ({ ...(await original<typeof import('undici')>()), fetch: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function response() {
  return new Response(
    JSON.stringify({
      id: 'long-request',
      object: 'chat.completion',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('Cancellable model transport', () => {
  it('uses the same configured endpoint, model and key for the parent, parallel children and summaries', async () => {
    const requests: Array<{
      authorization: string | null;
      url: string;
      model: string;
      child: boolean;
      summary: boolean;
      assistantReasoning: Array<string | undefined>;
    }> = [];
    vi.mocked(transportFetch).mockImplementation(async (url, options) => {
      const body = JSON.parse(String(options!.body));
      const child = body.messages[0]?.content.includes('你是子 Agent');
      const summary = body.messages[0]?.content.includes('你是会话上下文压缩器');
      requests.push({
        authorization: new Headers(options!.headers as HeadersInit).get('authorization'),
        url: String(url),
        model: body.model,
        child,
        summary,
        assistantReasoning: body.messages
          .filter((message: { role: string }) => message.role === 'assistant')
          .map((message: { reasoning_content?: string }) => message.reasoning_content),
      });
      if (requests.length > 12) throw new Error('Unexpected request sequence: ' + JSON.stringify(requests));
      const hasResult = body.messages.at(-1)?.role === 'tool';
      const call = child
        ? { name: 'read_file', arguments: '{"path":"hello.txt"}' }
        : {
            name: 'delegate_tasks',
            arguments: JSON.stringify({
              mode: 'parallel',
              tasks: [
                { name: '分析', task: '读取文件并分析' },
                { name: '审查', task: '读取文件并审查' },
              ],
            }),
          };
      const delta =
        summary || hasResult
          ? { role: 'assistant', content: summary ? '已完成历史工作。' : child ? '子任务已完成。' : '主任务已汇总。' }
          : {
              role: 'assistant',
              content: '',
              reasoning_content: child ? '' : '先获取工具证据。',
              tool_calls: [{ index: 0, id: 'same-provider-id', type: 'function', function: call }],
            };
      const chunk = {
        id: crypto.randomUUID(),
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: summary || hasResult ? 'stop' : 'tool_calls' }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }) as never;
    });
    const model = createOpenAICompatibleModel({
      baseUrl: 'https://example.com/v1',
      apiKey: 'stored-model-key',
      model: 'configured-model',
      streamUsage: false,
    });
    const tasks = new Map<string, AgentTask>();
    const runtime = new LangChainAgentRuntime(model, { name: 'shared-model', systemPrompt: '按任务分工。' });
    for await (const _event of runtime.stream(
      [{ role: 'user', content: '创建两个子任务。' }],
      new AbortController().signal,
      {
        workspacePath: '/workspace',
        permissionMode: 'read-only',
        recordSubagent: (task) => tasks.set(task.id, task),
        async *execute() {
          return { content: '完整证据', failed: false };
        },
      },
    )) {
      /* Run the parent and both real child graphs through the HTTP adapter. */
    }
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      for (const reasoning of request.assistantReasoning)
        expect(reasoning).toBe(request.child ? '' : '先获取工具证据。');
    }
    expect([...tasks.values()].map((task) => task.status)).toEqual(['succeeded', 'succeeded']);
    const tokenizer = vi
      .spyOn(model.completions, 'getNumTokens')
      .mockRejectedValue(new Error('Tokenizer download must not be required'));
    const compressor = new ContextCompressor(model, { contextWindowTokens: 8192, maxOutputTokens: 512 });
    await compressor.prepare(
      [
        { role: 'user', content: '历史'.repeat(6000) },
        { role: 'assistant', content: '已完成' },
        { role: 'user', content: '继续' },
      ],
      '',
      [],
      [],
      1,
      new AbortController().signal,
    );
    expect(requests.some((request) => request.summary)).toBe(true);
    expect(tokenizer).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.child)).toHaveLength(4);
    for (const request of requests)
      expect(request).toMatchObject({
        authorization: 'Bearer stored-model-key',
        url: 'https://example.com/v1/chat/completions',
        model: 'configured-model',
      });
  });

  it('preserves a provider length stop through the HTTP stream and LangChain graph', async () => {
    vi.mocked(transportFetch).mockImplementation(async () => {
      const chunk = {
        id: 'limited',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '', reasoning_content: '尚在思考' },
            finish_reason: 'length',
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }) as never;
    });
    const model = createOpenAICompatibleModel({
      baseUrl: 'https://example.com/v1',
      apiKey: 'fixture',
      model: 'fixture',
      streamUsage: false,
      maxOutputTokens: 4096,
    });
    const runtime = new LangChainAgentRuntime(model, { name: 'limited', systemPrompt: '讨论' });
    const consume = async () => {
      for await (const _event of runtime.stream(
        [{ role: 'user', content: '讨论话题' }],
        new AbortController().signal,
      )) {
        /* Consume the actual provider finish reason. */
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ModelOutputLimitError);
    expect(JSON.parse(String(vi.mocked(transportFetch).mock.calls[0]![1]!.body)).max_tokens).toBe(4096);
  });
  it('sends each concurrent child its own reasoning and paired tool IDs through the actual HTTP adapter', async () => {
    const requests: Array<{
      messages: Array<{
        content: string;
        reasoning_content?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id: string }>;
      }>;
      max_tokens?: number;
      max_completion_tokens?: number;
    }> = [];
    vi.mocked(transportFetch).mockImplementation(async (_url, options) => {
      requests.push(JSON.parse(String(options!.body)));
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }) as never;
    });
    const model = createOpenAICompatibleModel({
      baseUrl: 'https://example.com/v1',
      apiKey: 'fixture',
      model: 'fixture',
      streamUsage: false,
      maxOutputTokens: 0,
    });
    await Promise.all(
      ['正方', '反方'].map(async (name) => {
        const stream = await model.stream([
          new HumanMessage(name),
          new AIMessage({
            content: '',
            additional_kwargs: { reasoning_content: `${name}需要读取证据` },
            tool_calls: [{ id: `${name}-call`, name: 'read_file', args: { path: 'a.txt' }, type: 'tool_call' }],
          }),
          new ToolMessage({ content: '证据', tool_call_id: `${name}-call` }),
        ]);
        for await (const _chunk of stream) {
          /* Drain both real provider streams. */
        }
      }),
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const name = request.messages[0]!.content;
      expect(request.messages[1]!.reasoning_content).toBe(`${name}需要读取证据`);
      expect(request.messages[1]!.tool_calls![0]!.id).toBe(request.messages[2]!.tool_call_id);
      expect(request.max_tokens).toBeUndefined();
      expect(request.max_completion_tokens).toBeUndefined();
    }
  });

  it.each(['finish', 'cancel'])(
    'waits past SDK defaults and responds to %s without retrying the request',
    async (action) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const started = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<Response>();
      vi.mocked(transportFetch).mockImplementation((_url, options) => {
        const signal = options!.signal!;
        started.resolve(signal);
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          release.promise.then(resolve as (value: Response) => void, reject);
        });
      });
      const client = new CancellableOpenAI({
        apiKey: 'fixture-only',
        baseURL: 'https://example.com/v1',
        maxRetries: 0,
      });
      const controller = new AbortController();
      const result = client.chat.completions.create(
        { model: 'fixture', messages: [{ role: 'user', content: '长任务' }] },
        { signal: controller.signal },
      );
      void result.catch(() => {});
      try {
        const signal = await started.promise;
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        expect(signal.aborted).toBe(false);
        vi.useRealTimers();
        if (action === 'cancel') {
          controller.abort();
          await expect(result).rejects.toThrow();
          expect(signal.aborted).toBe(true);
        } else {
          release.resolve(response());
          expect((await result).choices[0]?.message.content).toBe('完成');
        }
        expect(transportFetch).toHaveBeenCalledTimes(1);
      } finally {
        controller.abort();
        release.resolve(response());
        await result.catch(() => {});
      }
    },
  );
});
