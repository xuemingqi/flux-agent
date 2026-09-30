import { describe, expect, it, vi } from 'vitest';
import { AIMessageChunk, SystemMessage } from '@langchain/core/messages';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { LangChainAgentRuntime } from '../src/agents/langchain-agent-runtime.js';
import { createCapabilityTools } from '../src/tools/capability-tools.js';
import type { AgentEvent, AgentExecutionContext } from '../src/agents/agent-runtime.js';

describe('Agent capability integration', () => {
  it('offers only query tools in read-only mode and refreshes the capability catalog between model requests', async () => {
    let enabled = true;
    const chunks = [
      new AIMessageChunk({
        content: '',
        tool_calls: [{ id: 'load', name: 'read_skill', args: { name: 'workflow' }, type: 'tool_call' }],
      }),
    ];
    const model = new FakeStreamingChatModel({ chunks });
    const binding = vi.spyOn(model, 'bindTools').mockReturnValue(model);
    const prompts: string[] = [];
    const generate = model._generate.bind(model);
    vi.spyOn(model, '_generate').mockImplementation((messages, options, manager) => {
      prompts.push(String(messages.find((message) => message instanceof SystemMessage)?.content));
      return generate(messages, options, manager);
    });
    const stream = model._streamResponseChunks.bind(model);
    vi.spyOn(model, '_streamResponseChunks').mockImplementation(async function* (messages, options, manager) {
      prompts.push(String(messages.find((message) => message instanceof SystemMessage)?.content));
      yield* stream(messages, options, manager);
    });
    const execution: AgentExecutionContext = {
      workspacePath: '/workspace',
      permissionMode: 'read-only',
      getCapabilities: () => ({
        skills: enabled ? [{ name: 'workflow', description: 'WORKFLOW-CATALOG-MARKER' }] : [],
        mcps: [],
      }),
      async *execute(request) {
        expect(request.name).toBe('read_skill');
        enabled = false;
        chunks.splice(0, chunks.length, new AIMessageChunk('Workflow completed'));
        return { content: 'Loaded workflow instructions', failed: false };
      },
    };
    const names = createCapabilityTools(execution, new AbortController().signal).map((tool) => tool.name);
    expect(names).toContain('read_skill');
    expect(names).not.toContain('create_skill');
    expect(names).not.toContain('call_mcp_tool');
    const events: AgentEvent[] = [];
    const runtime = new LangChainAgentRuntime(model, {
      name: 'capability-test',
      systemPrompt: 'Use available capabilities.',
    });
    for await (const event of runtime.stream(
      [{ role: 'user', content: 'Use workflow' }],
      new AbortController().signal,
      execution,
    ))
      events.push(event);
    expect(binding).toHaveBeenCalled();
    expect(prompts[0]).toContain('WORKFLOW-CATALOG-MARKER');
    expect(prompts[1]).not.toContain('WORKFLOW-CATALOG-MARKER');
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.end', failed: false }));
  });

  it('keeps MCP credential values out of streamed tool input while executing the original parameters', async () => {
    const chunks = [
      new AIMessageChunk({
        content: '',
        tool_calls: [
          {
            id: 'mcp-create',
            name: 'create_mcp_server',
            args: {
              name: 'remote',
              transport: 'http',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'private-fixture-value' },
            },
            type: 'tool_call',
          },
        ],
      }),
    ];
    const model = new FakeStreamingChatModel({ chunks });
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    const events: AgentEvent[] = [];
    const runtime = new LangChainAgentRuntime(model, { name: 'credential-test', systemPrompt: 'Configure MCP.' });
    for await (const event of runtime.stream([{ role: 'user', content: 'Create MCP' }], new AbortController().signal, {
      workspacePath: '/workspace',
      permissionMode: 'full-access',
      getCapabilities: () => ({ skills: [], mcps: [] }),
      async *execute(request) {
        expect(request.input).toMatchObject({ headers: { Authorization: 'private-fixture-value' } });
        chunks.splice(0, chunks.length, new AIMessageChunk('Configured'));
        return { content: 'Configured', failed: false };
      },
    }))
      events.push(event);
    const start = events.find((event) => event.type === 'tool.start');
    expect(JSON.stringify(start)).toContain('Authorization');
    expect(JSON.stringify(start)).not.toContain('private-fixture-value');
  });
});
