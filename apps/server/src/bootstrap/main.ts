import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chatAgentDefinition, createOpenAICompatibleModel, LangChainAgentRuntime } from '@flux-agent/agent-runtime';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { pino } from 'pino';
import { createApp } from '../api/app.js';
import { SqliteRunStore } from '../storage/sqlite-run-store.js';
import { realpathSync } from 'node:fs';
import { RunManager } from '../runs/run-manager.js';
import { loadConfiguration } from './configuration.js';
import { ModelSettingsService } from '../settings/model-settings-service.js';
import { DirectoryPicker } from '../workspaces/directory-picker.js';

const configuration = loadConfiguration(process.env);
const logger = pino();
const store = new SqliteRunStore(join(configuration.FLUX_DATA_DIR, 'app.db'));
await store.modelSettings.migrateLegacy(join(configuration.FLUX_DATA_DIR, 'model.json'));
const settings = new ModelSettingsService(
  store.modelSettings,
  {
    baseUrl: configuration.MODEL_BASE_URL,
    apiKey: configuration.MODEL_API_KEY,
    model: configuration.MODEL_NAME,
    streamUsage: configuration.MODEL_STREAM_USAGE,
  },
  (model) => new LangChainAgentRuntime(createOpenAICompatibleModel(model), chatAgentDefinition, model),
);
await settings.initialize();
const manager = new RunManager(store, () => settings.getRuntime(), logger, realpathSync(configuration.FLUX_DATA_DIR));
if (!manager.workspaces.list().length) manager.workspaces.create(configuration.FLUX_WORKSPACE_DIR);
const origins = [configuration.PORT, configuration.WEB_PORT].flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);
const directoryPicker = new DirectoryPicker();
const app = createApp({ manager, logger, origins, settings, directoryPicker });
const webRoot = fileURLToPath(new URL('../../../web/dist', import.meta.url));
app.use('*', serveStatic({ root: webRoot }));
app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: configuration.PORT }, (address) => {
  logger.info(
    { url: `http://127.0.0.1:${address.port}`, configured: settings.getSettings().configured },
    'Flux Agent ready',
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 5000).unref();
  server.close();
  directoryPicker.cancel();
  await manager.shutdown();
  store.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  clearTimeout(deadline);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
