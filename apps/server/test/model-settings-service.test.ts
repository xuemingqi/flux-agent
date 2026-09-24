import { mkdtemp, access, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelConfiguration } from '@flux-agent/agent-runtime';
import { saveModelSettingsSchema } from '@flux-agent/contracts';
import { ModelSettingsService } from '../src/settings/model-settings-service.js';
import { SqliteRunStore } from '../src/storage/sqlite-run-store.js';

const budget = { contextWindowTokens: 32768, maxOutputTokens: 4096 };
const directories: string[] = [];
const stores: SqliteRunStore[] = [];
const defaults: ModelConfiguration = {
  baseUrl: 'https://example.com/v1',
  model: '',
  apiKey: '',
  streamUsage: false,
};
const createRuntime = (configuration: ModelConfiguration) => ({
  async *stream() {
    yield { type: 'text.delta' as const, text: configuration.model };
  },
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), 'flux-settings-test-'));
  directories.push(directory);
  const path = join(directory, 'app.db');
  const store = new SqliteRunStore(path);
  stores.push(store);
  const service = new ModelSettingsService(store.modelSettings, defaults, createRuntime);
  await service.initialize();
  return { path, directory, store, service };
}

describe('ModelSettingsService', () => {
  it('persists provider-default output and supports explicit budgets above the old 8192 ceiling', async () => {
    const { service, store } = await createService();
    const input = saveModelSettingsSchema.parse({ baseUrl: defaults.baseUrl, model: 'reasoning', apiKey: 'fixture' });
    expect(input.maxOutputTokens).toBe(0);
    await service.save(input);
    expect(store.modelSettings.load()?.maxOutputTokens).toBe(0);
    await service.save(
      saveModelSettingsSchema.parse({ ...input, contextWindowTokens: 131072, maxOutputTokens: 32768 }),
    );
    expect(service.getSettings().maxOutputTokens).toBe(32768);
  });
  it('detects missing settings and persists a private configuration across restarts', async () => {
    const { path, directory, store, service } = await createService();
    expect(service.getSettings().configured).toBe(false);
    expect(service.getRuntime()).toBeNull();
    const input = { ...budget, baseUrl: defaults.baseUrl, model: 'saved-model', apiKey: 'private-key' };
    expect(await service.save(input)).toMatchObject({ configured: true, hasApiKey: true });
    expect(store.modelSettings.load()).toEqual(input);
    await expect(access(join(directory, 'model.json'))).rejects.toThrow();
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteRunStore(path);
    stores.push(reopened);
    const restarted = new ModelSettingsService(
      reopened.modelSettings,
      { ...defaults, model: 'environment-model', apiKey: 'environment-key' },
      createRuntime,
    );
    await restarted.initialize();
    expect(restarted.getSettings()).toMatchObject({ model: 'saved-model', ...budget });
    expect(JSON.stringify(restarted.getSettings())).not.toContain('private-key');
  });

  it('preserves a hidden key for the same endpoint and requires a new key when the endpoint changes', async () => {
    const { store, service } = await createService();
    await service.save({ ...budget, baseUrl: defaults.baseUrl, model: 'first', apiKey: 'private-key' });
    const previousRuntime = service.getRuntime();
    await service.save({ ...budget, baseUrl: defaults.baseUrl, model: 'second', apiKey: '' });
    expect(store.modelSettings.load()?.apiKey).toBe('private-key');
    expect(service.getRuntime()).not.toBe(previousRuntime);
    const oldOutput = [];
    for await (const event of previousRuntime!.stream([], new AbortController().signal)) oldOutput.push(event);
    expect(oldOutput).toEqual([{ type: 'text.delta', text: 'first' }]);
    await expect(
      service.save({ ...budget, baseUrl: 'https://different.example/v1', model: 'third', apiKey: '' }),
    ).rejects.toThrow('API Key');
    expect(service.getSettings().model).toBe('second');
  });

  it('keeps the current runtime unchanged when persistence fails', async () => {
    const { store, service } = await createService();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    await expect(
      service.save({ ...budget, baseUrl: defaults.baseUrl, model: 'failed', apiKey: 'private-key' }),
    ).rejects.toThrow('无法保存');
    expect(service.getSettings().configured).toBe(false);
    expect(service.getRuntime()).toBeNull();
  });

  it('migrates a legacy file once and never overwrites a newer SQLite configuration', async () => {
    const { store, directory } = await createService();
    const path = join(directory, 'model.json');
    const legacy = { baseUrl: defaults.baseUrl, model: 'legacy', apiKey: 'legacy-key' };
    await writeFile(path, JSON.stringify(legacy));
    await store.modelSettings.migrateLegacy(path);
    expect(store.modelSettings.load()).toEqual({ ...legacy, ...budget, maxOutputTokens: 0 });
    await expect(access(path)).rejects.toThrow();
    store.modelSettings.save({ ...budget, ...legacy, model: 'newer' });
    await writeFile(path, JSON.stringify(legacy));
    await store.modelSettings.migrateLegacy(path);
    expect(store.modelSettings.load()?.model).toBe('newer');
    await expect(access(path)).rejects.toThrow();
  });
});
