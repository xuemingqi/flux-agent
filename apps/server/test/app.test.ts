import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pino } from 'pino';
import { createApp } from '../src/api/app.js';
import { InMemoryRunStore } from '../src/runs/in-memory-run-store.js';
import { RunManager } from '../src/runs/run-manager.js';
import { ModelSettingsService } from '../src/settings/model-settings-service.js';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';

const directories: string[] = [];
const stores: SqliteRunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(configured = true, protectData = false) {
  const logger = pino({ enabled: false });
  const runtime = {
    async *stream() {
      yield { type: 'text.delta' as const, text: '真实事件流' };
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'flux-api-test-'));
  directories.push(directory);
  const store = new SqliteRunStore(join(directory, 'app.db'));
  stores.push(store);
  const settings = new ModelSettingsService(
    store.modelSettings,
    {
      baseUrl: 'https://example.com/v1',
      model: configured ? 'test' : '',
      apiKey: configured ? 'secret-key' : '',
      streamUsage: false,
    },
    () => runtime,
  );
  await settings.initialize();
  const manager = new RunManager(
    new InMemoryRunStore(),
    () => settings.getRuntime(),
    logger,
    protectData ? directory : undefined,
  );
  const choose = vi.fn<() => Promise<string | null>>().mockResolvedValue(directory);
  const app = createApp({ manager, logger, origins: ['http://localhost'], settings, directoryPicker: { choose } });
  const session = await app.request('/api/session', { headers: { 'x-flux-client': 'web' } });
  const { token } = await session.json();
  const headers = { cookie: `flux_session=${token}`, 'x-flux-token': token, 'content-type': 'application/json' };
  return { app, manager, headers, choose, directory };
}

describe('Local chat API', () => {
  it('previews files with local authentication and workspace path protections without adding messages', async () => {
    const { app, manager, headers, directory } = await setup(true, true);
    const root = await mkdtemp(join(tmpdir(), 'flux-preview-test-'));
    directories.push(root);
    await writeFile(join(root, 'hello.txt'), 'preview only');
    await writeFile(join(directory, 'protected.txt'), 'private configuration');
    await symlink(join(directory, 'protected.txt'), join(root, 'escape.txt'));
    const workspace = manager.workspaces.create(root);
    const thread = manager.createThread(workspace.id);
    const endpoint = `/api/threads/${thread.id}/file`;
    const read = (path: string) => app.request(`${endpoint}?path=${encodeURIComponent(path)}`, { headers });
    expect((await app.request(`${endpoint}?path=hello.txt`)).status).toBe(401);
    expect(
      (await app.request(`${endpoint}?path=hello.txt`, { headers: { ...headers, origin: 'https://evil.example' } }))
        .status,
    ).toBe(403);
    expect((await app.request(endpoint, { headers })).status).toBe(400);
    expect((await read('\0')).status).toBe(400);
    expect((await read('missing.txt')).status).toBe(400);
    expect((await read('escape.txt')).status).toBe(403);
    expect((await read(join(directory, 'protected.txt'))).status).toBe(403);
    const response = await read('hello.txt');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: 'preview only' });
    expect(manager.getThread(thread.id)).toEqual(thread);
    manager.setPermission(thread.id, 'full-access', true);
    const protectedRead = await read(join(directory, 'protected.txt'));
    expect(protectedRead.status).toBe(403);
    expect(await protectedRead.json()).toMatchObject({ code: 'PROTECTED_PATH' });
  });

  it('authenticates thread actions and validates names before renaming or deleting', async () => {
    const { app, manager, headers } = await setup();
    const thread = manager.createThread();
    const rename = `/api/threads/${thread.id}/rename`;
    const remove = `/api/threads/${thread.id}/delete`;
    for (const endpoint of [rename, remove])
      expect((await app.request(endpoint, { method: 'POST', body: '{}' })).status).toBe(401);
    for (const title of ['', ' ', 'x'.repeat(101)])
      expect((await app.request(rename, { method: 'POST', headers, body: JSON.stringify({ title }) })).status).toBe(
        400,
      );
    const saved = await app.request(rename, { method: 'POST', headers, body: JSON.stringify({ title: ' 项目会话 ' }) });
    expect(await saved.json()).toMatchObject({ title: '项目会话' });
    expect((await app.request(remove, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect((await app.request(`/api/threads/${thread.id}`, { headers })).status).toBe(404);
  });
  it('authenticates workspace actions and steering, validates input and rejects closed runs', async () => {
    const { app, manager, headers } = await setup();
    const workspace = manager.workspaces.create(process.cwd());
    const thread = manager.createThread(workspace.id);
    const run = manager.startRun(thread.id, 'hello');
    await vi.waitFor(() => expect(manager.getRun(run.id).finishedAt).not.toBeNull());
    const steer = `/api/runs/${run.id}/steer`;
    const rename = `/api/workspaces/${workspace.id}/rename`;
    const archive = `/api/workspaces/${workspace.id}/archive`;
    for (const endpoint of [steer, rename, archive]) {
      expect(
        (await app.request(endpoint, { method: 'POST', headers: { cookie: headers.cookie }, body: '{}' })).status,
      ).toBe(401);
    }
    for (const body of [
      { content: 'missing ID' },
      { id: crypto.randomUUID(), content: ' ' },
      { id: crypto.randomUUID(), content: 'hi', permissionMode: 'full-access' },
    ]) {
      expect((await app.request(steer, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(
      (
        await app.request(steer, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: crypto.randomUUID(), content: 'too late' }),
        })
      ).status,
    ).toBe(409);
    expect((await app.request(rename, { method: 'POST', headers, body: JSON.stringify({ name: ' ' }) })).status).toBe(
      400,
    );
    const saved = await app.request(rename, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '  自定义名称  ' }),
    });
    expect(await saved.json()).toMatchObject({ name: '自定义名称', rootPath: workspace.rootPath });
    expect((await app.request(archive, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect(() => manager.getThread(thread.id)).toThrow('会话不存在');
    expect(() => manager.getRun(run.id)).toThrow('运行不存在');
  });

  it('authenticates and validates feedback and rejects stale edits', async () => {
    const { app, manager, headers } = await setup();
    const run = manager.startRun(manager.createThread().id, '反馈测试');
    await vi.waitFor(() => expect(manager.getRun(run.id).finishedAt).not.toBeNull());
    const endpoint = `/api/runs/${run.id}/feedback`;
    const input = { rating: 'helpful', comment: '继续保持', version: 0 };
    expect((await app.request(endpoint, { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
    for (const value of [
      null,
      { ...input, rating: 'fake' },
      { ...input, comment: 'a'.repeat(2001) },
      { ...input, version: -1 },
    ]) {
      expect((await app.request(endpoint, { method: 'POST', headers, body: JSON.stringify(value) })).status).toBe(400);
    }
    expect(
      (await app.request('/api/runs/missing/feedback', { method: 'POST', headers, body: JSON.stringify(input) }))
        .status,
    ).toBe(404);
    const saved = await app.request(endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ feedback: { ...input, version: 1 } });
    const stale = await app.request(endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT' });
  });
  it('opens the native picker only for authenticated requests and does not change workspaces on cancellation', async () => {
    const { app, manager, headers, choose } = await setup();
    const endpoint = '/api/workspaces/choose';
    expect((await app.request(endpoint, { method: 'POST' })).status).toBe(401);
    expect(
      (await app.request(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } })).status,
    ).toBe(403);
    expect(choose).not.toHaveBeenCalled();
    const selected = await app.request(endpoint, { method: 'POST', headers, body: '{}' });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ workspace: { id: expect.any(String) } });
    expect(manager.workspaces.list()).toHaveLength(1);
    choose.mockResolvedValueOnce(null);
    expect(await (await app.request(endpoint, { method: 'POST', headers, body: '{}' })).json()).toEqual({
      workspace: null,
    });
    expect(manager.workspaces.list()).toHaveLength(1);
    await app.request(endpoint, { method: 'POST', headers, body: '{}' });
    expect(manager.workspaces.list()).toHaveLength(1);
  });

  it('protects memory writes, validates workspace scope, and rejects stale edits and invalid budgets', async () => {
    const { app, manager, headers } = await setup();
    const workspace = manager.workspaces.create(process.cwd());
    const endpoint = `/api/workspaces/${workspace.id}/memories`;
    expect((await app.request(endpoint)).status).toBe(401);
    expect((await app.request('/api/workspaces/missing/memories', { headers })).status).toBe(404);
    expect(
      (
        await app.request('/api/workspaces/missing/memories', {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'x' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(endpoint, {
          method: 'POST',
          headers: { cookie: headers.cookie },
          body: JSON.stringify({ content: 'unsafe' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request(endpoint, { method: 'POST', headers, body: JSON.stringify({ content: ' ' }) })).status,
    ).toBe(400);
    const created = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: '使用 TypeScript' }),
    });
    expect(created.status).toBe(201);
    const memory = await created.json();
    const update = { content: '使用 SQLite', version: memory.version, state: 'active' };
    expect(
      (await app.request(`${endpoint}/${memory.id}`, { method: 'POST', headers, body: JSON.stringify(update) })).status,
    ).toBe(200);
    expect(
      (await app.request(`${endpoint}/${memory.id}`, { method: 'POST', headers, body: JSON.stringify(update) })).status,
    ).toBe(409);
    const listed = await (await app.request(`${endpoint}?q=SQLite`, { headers })).json();
    expect(listed).toMatchObject([{ content: '使用 SQLite', version: 2, state: 'active' }]);
    expect(
      (
        await app.request(`${endpoint}/${memory.id}/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ version: 2 }),
        })
      ).status,
    ).toBe(200);
    const invalidBudget = await app.request('/api/settings/model', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseUrl: 'https://example.com/v1',
        model: 'test',
        contextWindowTokens: 8192,
        maxOutputTokens: 8192,
      }),
    });
    expect(invalidBudget.status).toBe(400);
    expect(await invalidBudget.json()).toMatchObject({ code: 'INVALID_CONTEXT_BUDGET' });
  });

  it('configures a missing model without restart and never returns the API key', async () => {
    const { app, headers } = await setup(false);
    const endpoint = '/api/settings/model';
    expect((await app.request(endpoint)).status).toBe(401);
    const invalid = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseUrl: 'file:///etc/passwd', model: 'test' }),
    });
    expect(invalid.status).toBe(400);
    const saved = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseUrl: 'https://example.com/v1', model: 'new-model', apiKey: 'never-return-this-key' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      baseUrl: 'https://example.com/v1',
      model: 'new-model',
      hasApiKey: true,
      configured: true,
      contextWindowTokens: 32768,
      maxOutputTokens: 0,
    });
    expect(await (await app.request(endpoint, { headers })).text()).not.toContain('never-return-this-key');
    const session = await app.request('/api/session', { headers: { 'x-flux-client': 'web' } });
    expect(await session.json()).toMatchObject({ configured: true, model: 'new-model' });
    const thread = await (await app.request('/api/threads', { method: 'POST', headers })).json();
    expect(
      (
        await app.request(`/api/threads/${thread.id}/runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: '已配置' }),
        })
      ).status,
    ).toBe(201);
  });

  it('requires local origin, local host and a valid browser session', async () => {
    const { app, headers } = await setup();
    expect((await app.request('/api/session')).status).toBe(403);
    expect((await app.request('/api/threads')).status).toBe(401);
    expect(
      (await app.request('/api/threads', { headers: { ...headers, origin: 'https://evil.example' } })).status,
    ).toBe(403);
    expect((await app.request('/api/threads', { headers: { ...headers, host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('/api/threads', { method: 'POST', headers: { cookie: headers.cookie } })).status).toBe(
      401,
    );
  });

  it('validates messages and returns a complete terminal snapshot to late SSE subscribers', async () => {
    const { app, manager, headers } = await setup();
    const created = await app.request('/api/threads', { method: 'POST', headers });
    const thread = await created.json();
    for (const body of ['{', JSON.stringify({ content: '  ' }), JSON.stringify({ content: 'a'.repeat(32001) })]) {
      expect((await app.request(`/api/threads/${thread.id}/runs`, { method: 'POST', headers, body })).status).toBe(400);
    }
    const response = await app.request(`/api/threads/${thread.id}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: '你好' }),
    });
    expect(response.status).toBe(201);
    const run = await response.json();
    await new Promise<void>((resolve) => {
      if (manager.getRun(run.id).finishedAt) return resolve();
      const unsubscribe = manager.subscribe(run.id, () => {
        if (manager.getRun(run.id).finishedAt) {
          unsubscribe();
          resolve();
        }
      });
    });
    const stream = await app.request(`/api/runs/${run.id}/events`, { headers });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const events = await stream.text();
    expect(events).toContain('run.snapshot');
    expect(events).toContain('真实事件流');
    expect(events).toContain('succeeded');
    expect((await app.request('/api/runs/missing/events', { headers })).status).toBe(404);
  });
});
