import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zipSync, unzipSync } from 'fflate';
import { pino } from 'pino';
import { mcpInputSchema, runSchema, skillInputSchema, type PermissionMode } from '@flux-agent/contracts';
import type { ToolResult } from '@flux-agent/agent-runtime';
import { InMemoryCapabilityStore } from '../src/storage/capability-store.js';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';
import { SkillService } from '../src/skills/skill-service.js';
import { McpService } from '../src/mcp/mcp-service.js';
import { CapabilityPageService } from '../src/settings/capability-page-service.js';
import { CapabilityToolService } from '../src/tools/capability-tool-service.js';
import { ToolExecutionService } from '../src/tools/tool-execution-service.js';
import { InMemoryRunStore } from '../src/runs/in-memory-run-store.js';
import { ApprovalService } from '../src/permissions/approval-service.js';
import { RunManager } from '../src/runs/run-manager.js';
import { createApp } from '../src/api/app.js';
import { ModelSettingsService } from '../src/settings/model-settings-service.js';

const paths: string[] = [];
const databases: SqliteRunStore[] = [];
const servers: Server[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const markdown = (name = 'sample', body = 'Follow the verified workflow.') =>
  `---\nname: ${name}\ndescription: Use for sample tasks\n---\n\n${body}\n`;
const skill = (name = 'sample') => skillInputSchema.parse({ name, markdown: markdown(name) });
const mcp = (name = 'sample-mcp') =>
  mcpInputSchema.parse({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('../../../tests/fixtures/mcp-server.mjs', import.meta.url))],
  });

function fixture(mode: PermissionMode = 'full-access') {
  const store = new InMemoryRunStore();
  const skills = new SkillService(store.capabilities);
  const mcps = new McpService(store.capabilities);
  const run = runSchema.parse({
    id: 'run',
    threadId: 'thread',
    workspaceId: 'workspace',
    permissionMode: mode,
    assistantMessageId: 'message',
    status: 'running',
    output: '',
    steps: [],
    approvals: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    usage: null,
    error: null,
  });
  const approvals = new ApprovalService(() => {});
  const tools = new CapabilityToolService(skills, mcps, approvals);
  const page = new CapabilityPageService(skills, mcps);
  const service = new ToolExecutionService(store, approvals, undefined, undefined, undefined, tools);
  const context = service.context(run, {
    id: 'workspace',
    name: 'test',
    rootPath: process.cwd(),
    createdAt: run.createdAt,
    archivedAt: null,
  });
  const signal = new AbortController().signal;
  const execute = (name: string, input: unknown, id = crypto.randomUUID()) =>
    collect(context.execute({ id, name, input }, signal));
  return { store, skills, mcps, run, approvals, tools, page, context, execute, signal };
}

async function collect(iterator: AsyncGenerator<string, ToolResult>): Promise<ToolResult> {
  let value = await iterator.next();
  while (!value.done) value = await iterator.next();
  return value.value;
}

describe('Shared Skill foundation', () => {
  it('preserves original Markdown and binary resources across export/import and rejects collisions', () => {
    const foundation = new SkillService(new InMemoryCapabilityStore());
    const original = {
      ...skill(),
      files: [
        { path: 'assets/icon.bin', content: Buffer.from([0, 128, 255]).toString('base64') },
        { path: 'scripts/task.py', content: Buffer.from('print("hello")\n').toString('base64') },
      ],
    };
    foundation.create(original);
    const archive = foundation.export('sample');
    const bytes = unzipSync(Buffer.from(archive.content, 'base64'));
    expect(Buffer.from(bytes['sample/assets/icon.bin']!)).toEqual(Buffer.from([0, 128, 255]));
    const target = new SkillService(new InMemoryCapabilityStore());
    expect(target.import(archive.filename, archive.content)).toMatchObject(original);
    expect(() => target.import(archive.filename, archive.content)).toThrow('同名');
    expect(foundation.read('sample', 'scripts/task.py').content).toBe('print("hello")\n');
    expect(() => foundation.read('sample', 'assets/icon.bin')).toThrow('UTF-8');
    foundation.update('sample', { ...skill(), files: undefined, version: 1, enabled: false });
    expect(foundation.get('sample').files).toEqual(original.files);
    expect(() => foundation.read('sample')).toThrow('禁用');
    expect(() => foundation.delete('sample', 1)).toThrow('已变化');
    foundation.delete('sample', 2);
    expect(foundation.list()).toEqual([]);
  });

  it('rejects unsafe paths, links, oversized expansion and multiple manifests before any write', () => {
    const foundation = new SkillService(new InMemoryCapabilityStore());
    const archive = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));
    const manifest = Buffer.from(markdown());
    const imports = [
      archive({ 'sample/SKILL.md': manifest, '../escape': Buffer.from('bad') }),
      archive({ 'sample/SKILL.md': manifest, 'other/SKILL.md': manifest }),
      archive({ 'sample/SKILL.md': manifest, 'outside.txt': Buffer.from('bad') }),
      archive({ 'sample/SKILL.md': manifest, 'sample/A.txt': Buffer.from('a'), 'sample/a.txt': Buffer.from('b') }),
    ];
    const link = archive({ 'sample/SKILL.md': manifest });
    const directory = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    link.writeUInt32LE(0xa1ff0000, directory + 38);
    imports.push(link);
    const bomb = archive({ 'sample/SKILL.md': manifest });
    bomb.writeUInt32LE(30_000_000, bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    imports.push(bomb);
    for (const bytes of imports) expect(() => foundation.import('bad.zip', bytes.toString('base64'))).toThrow();
    expect(() => foundation.create({ ...skill(), markdown: 'no metadata' })).toThrow();
    expect(() => foundation.create({ ...skill(), files: [{ path: '../escape', content: '' }] })).toThrow();
    expect(foundation.list()).toEqual([]);
  });

  it('shares page and tool writes and restores both capabilities from SQLite after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'flux-capability-'));
    paths.push(directory);
    const first = new SqliteRunStore(join(directory, 'app.db'));
    const skills = new SkillService(first.capabilities);
    const mcps = new McpService(first.capabilities);
    const page = new CapabilityPageService(skills, mcps);
    page.createSkill(skill());
    page.createMcp({ ...mcp(), env: { TEST_CREDENTIAL: 'private-value' } });
    const local = fixture();
    const tool = new CapabilityToolService(skills, mcps, local.approvals);
    await collect(
      tool.execute(
        local.run,
        { id: 'edit', name: 'update_skill', input: {} },
        { name: 'update_skill', input: { ...skill(), markdown: markdown('sample', 'Updated by agent'), version: 1 } },
        'hash',
        local.signal,
      ),
    );
    expect(page.getSkill('sample').markdown).toContain('Updated by agent');
    expect(JSON.stringify(page.listMcps())).not.toContain('private-value');
    first.close();
    const restored = new SqliteRunStore(join(directory, 'app.db'));
    databases.push(restored);
    expect(new SkillService(restored.capabilities).get('sample').version).toBe(2);
    expect(new McpService(restored.capabilities).get('sample-mcp').env).toEqual({ TEST_CREDENTIAL: 'private-value' });
  });
});

describe('Capability tool permissions and audit', () => {
  it('rejects a transport change between the permission check and connection creation', async () => {
    const value = fixture('read-only');
    const config = mcpInputSchema.parse({ name: 'changing', transport: 'http', url: 'https://example.com/mcp' });
    value.page.createMcp(config);
    const iterator = value.context.execute(
      { id: 'discover', name: 'list_mcp_tools', input: { name: 'changing' } },
      value.signal,
    );
    await iterator.next();
    value.page.updateMcp('changing', { ...mcp('changing'), version: 1 });
    expect(await collect(iterator)).toMatchObject({
      failed: true,
      content: expect.stringContaining('CAPABILITY_CONFLICT'),
    });
  });
  it('denies direct read-only writes and local process discovery without full access', async () => {
    const value = fixture('read-only');
    expect(await value.execute('create_skill', skill())).toMatchObject({
      failed: true,
      content: expect.stringContaining('CAPABILITY_WRITE_DENIED'),
    });
    value.page.createMcp(mcp());
    expect(await value.execute('list_mcp_tools', { name: 'sample-mcp' })).toMatchObject({
      failed: true,
      content: expect.stringContaining('MCP_PROCESS_DENIED'),
    });
    expect(value.page.listSkills()).toEqual([]);
    expect(await value.execute('create_skill', { ...skill(), name: '../bad' })).toMatchObject({ failed: true });
  });

  it('waits for approval, rejects changed resources and never replays the same tool ID', async () => {
    const value = fixture('workspace-write');
    const iterator = value.context.execute({ id: 'create', name: 'create_skill', input: skill() }, value.signal);
    expect((await iterator.next()).value).toContain('等待');
    const completion = collect(iterator);
    expect(value.page.listSkills()).toEqual([]);
    expect(value.run.approvals[0]).toMatchObject({ kind: 'capability', status: 'pending' });
    value.approvals.decide(value.run.id, value.run.approvals[0]!.id, 'approved');
    expect(await completion).toMatchObject({ failed: false });
    expect(value.page.listSkills()[0]?.name).toBe('sample');
    expect(await value.execute('delete_skill', { name: 'sample', version: 1 }, 'create')).toMatchObject({
      failed: true,
      content: expect.stringContaining('DUPLICATE_TOOL_CALL'),
    });
    const remove = value.context.execute(
      { id: 'delete', name: 'delete_skill', input: { name: 'sample', version: 1 } },
      value.signal,
    );
    await remove.next();
    const deleting = collect(remove);
    value.page.updateSkill('sample', { ...skill(), version: 1, markdown: markdown('sample', 'Newer user change') });
    value.approvals.decide(value.run.id, value.run.approvals[1]!.id, 'approved');
    expect(await deleting).toMatchObject({ failed: true, content: expect.stringContaining('CAPABILITY_CONFLICT') });
    expect(value.store.getExecution(value.run.id, 'delete')?.status).toBe('failed');
    expect(value.page.getSkill('sample').markdown).toContain('Newer user change');
    const denied = value.context.execute(
      { id: 'denied', name: 'delete_skill', input: { name: 'sample', version: 2 } },
      value.signal,
    );
    await denied.next();
    const denial = collect(denied);
    value.approvals.decide(value.run.id, value.run.approvals[2]!.id, 'denied');
    expect(await denial).toMatchObject({ failed: true, content: expect.stringContaining('APPROVAL_DENIED') });
    expect(value.page.getSkill('sample').version).toBe(2);
  });
});

describe('MCP protocol foundation', () => {
  it('supports legacy SSE with configured headers and cancels a handshake waiting for an endpoint', async () => {
    const transports = new Map<string, SSEServerTransport>();
    let handshakeReady: () => void = () => {};
    const handshake = new Promise<void>((resolve) => {
      handshakeReady = resolve;
    });
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer sse-fixture');
      if (request.url === '/stalled') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(': waiting\n\n');
        handshakeReady();
        return;
      }
      if (request.method === 'GET') {
        const transport = new SSEServerTransport('/messages', response);
        transports.set(transport.sessionId, transport);
        response.once('close', () => transports.delete(transport.sessionId));
        const protocol = new McpProtocolServer({ name: 'sse-test', version: '1' }, { capabilities: { tools: {} } });
        protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        }));
        protocol.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: 'text', text: 'SSE success' }],
        }));
        await protocol.connect(transport);
      } else {
        const session = new URL(request.url!, 'http://localhost').searchParams.get('sessionId')!;
        await transports.get(session)!.handlePostMessage(request, response);
      }
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const value = fixture();
    const config = mcpInputSchema.parse({
      name: 'legacy',
      transport: 'sse',
      url: `http://127.0.0.1:${address.port}/sse`,
      headers: { Authorization: 'Bearer sse-fixture' },
    });
    value.page.createMcp(config);
    expect((await value.mcps.listTools('legacy', value.signal)).tools[0]?.name).toBe('echo');
    expect(await value.mcps.callTool('legacy', 'echo', {}, value.signal)).toMatchObject({
      failed: false,
      content: expect.stringContaining('SSE success'),
    });
    value.page.updateMcp('legacy', { ...config, url: `http://127.0.0.1:${address.port}/stalled`, version: 1 });
    const controller = new AbortController();
    const pending = value.mcps.listTools('legacy', controller.signal);
    const assertion = expect(pending).rejects.toThrow('cancel fixture');
    await handshake;
    controller.abort(new Error('cancel fixture'));
    await assertion;
  });
  it('discovers and invokes a real stdio server through the audited tool boundary', async () => {
    const value = fixture();
    value.page.createMcp(mcp());
    const list = await value.execute('list_mcp_tools', { name: 'sample-mcp' });
    expect(list.failed).toBe(false);
    expect(JSON.parse(list.content).tools[0].name).toBe('echo');
    const result = await value.execute('call_mcp_tool', {
      name: 'sample-mcp',
      tool: 'echo',
      arguments: { text: 'hello MCP' },
    });
    expect(result).toMatchObject({ failed: false, content: expect.stringContaining('hello MCP') });
    expect(await value.execute('call_mcp_tool', { name: 'sample-mcp', tool: 'missing', arguments: {} })).toMatchObject({
      failed: true,
    });
    value.page.updateMcp('sample-mcp', { ...mcp(), version: 1, enabled: false });
    expect(await value.execute('call_mcp_tool', { name: 'sample-mcp', tool: 'echo', arguments: {} })).toMatchObject({
      failed: true,
      content: expect.stringContaining('MCP_DISABLED'),
    });
    expect(value.tools.catalog().mcps).toEqual([]);
  });

  it('uses configured HTTP headers, paginates tools and requires approval before external calls', async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      expect(request.headers.authorization).toBe('Bearer fixture-value');
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      requests.push(input.method);
      if (input.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        input.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : input.method === 'tools/list'
            ? {
                tools: [{ name: input.params?.cursor ? 'second' : 'echo', inputSchema: { type: 'object' } }],
                ...(input.params?.cursor ? {} : { nextCursor: 'page2' }),
              }
            : { content: [{ type: 'text', text: 'remote result' }] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const value = fixture('workspace-write');
    const config = mcpInputSchema.parse({
      name: 'remote',
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: 'Bearer fixture-value' },
    });
    const visible = value.page.createMcp(config);
    expect(visible.headerKeys).toEqual(['Authorization']);
    value.page.updateMcp('remote', { ...config, headers: undefined, version: 1 });
    expect(value.mcps.get('remote').headers).toEqual(config.headers);
    const list = await value.execute('list_mcp_tools', { name: 'remote' });
    expect(JSON.parse(list.content).tools.map((tool: { name: string }) => tool.name)).toEqual(['echo', 'second']);
    const iterator = value.context.execute(
      { id: 'remote-call', name: 'call_mcp_tool', input: { name: 'remote', tool: 'echo', arguments: {} } },
      value.signal,
    );
    await iterator.next();
    const completion = collect(iterator);
    expect(requests).not.toContain('tools/call');
    value.approvals.decide(value.run.id, value.run.approvals[0]!.id, 'approved');
    expect(await completion).toMatchObject({ failed: false, content: expect.stringContaining('remote result') });
    expect(requests).toContain('tools/call');
  });
});

describe('Capability API boundary', () => {
  it('authenticates both management routes and delegates to the shared page service', async () => {
    const logger = pino({ enabled: false });
    const store = new InMemoryRunStore();
    const manager = new RunManager(store, () => null, logger);
    const settings = new ModelSettingsService(
      { load: () => undefined, save: vi.fn() },
      { baseUrl: 'https://example.com/v1', apiKey: '', model: '', streamUsage: false },
      () => {
        throw new Error('Unused');
      },
    );
    const app = createApp({ manager, logger, settings, origins: ['http://localhost'] });
    const session = await (await app.request('/api/session', { headers: { 'x-flux-client': 'web' } })).json();
    const headers = {
      cookie: `flux_session=${session.token}`,
      'x-flux-token': session.token,
      'content-type': 'application/json',
    };
    for (const path of ['/api/skills', '/api/mcps']) {
      expect((await app.request(path)).status).toBe(401);
      expect(
        (await app.request(path, { method: 'POST', headers: { cookie: headers.cookie }, body: '{}' })).status,
      ).toBe(401);
    }
    const saved = await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify(skill()) });
    expect(saved.status).toBe(201);
    expect(manager.capabilities.getSkill('sample').version).toBe(1);
    expect((await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify(skill()) })).status).toBe(
      409,
    );
    const imported = await app.request('/api/skills/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'SKILL.md', content: Buffer.from(markdown('imported')).toString('base64') }),
    });
    expect(imported.status).toBe(201);
    const large = skillInputSchema.parse({
      name: 'larger',
      markdown: markdown('larger'),
      files: [{ path: 'resource.txt', content: Buffer.alloc(300_000, 'a').toString('base64') }],
    });
    expect((await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify(large) })).status).toBe(
      201,
    );
    const invalid = await app.request('/api/mcps', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'bad', transport: 'http', url: 'file:///bad' }),
    });
    expect(invalid.status).toBe(400);
  });
});
