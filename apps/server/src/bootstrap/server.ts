import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAgentDefinition, createOpenAICompatibleModel, LangChainAgentRuntime } from '@flux-agent/agent-runtime';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { pino } from 'pino';
import { createApp } from '../api/app.js';
import { RunManager } from '../runs/run-manager.js';
import { ModelSettingsService } from '../settings/model-settings-service.js';
import { SqliteRunStore } from '../storage/sqlite-run-store.js';
import { DirectoryPicker } from '../workspaces/directory-picker.js';
import { loadConfiguration } from './configuration.js';

interface ServerOptions {
  /** 桌面版传入 0，让操作系统分配空闲端口；CLI 仍使用配置端口。 */
  port?: number;
  /** null 表示首次启动由用户选择工作区。 */
  initialWorkspace?: string | null;
  directoryPicker?: Pick<DirectoryPicker, 'choose' | 'cancel'>;
}

/**
 * 两种入口共用后台初始化与清理，信号处理和应用退出由各自宿主管理。
 */
export async function startServer(options: ServerOptions = {}) {
  const configuration = loadConfiguration(process.env);
  const logger = pino();
  const store = new SqliteRunStore(join(configuration.FLUX_DATA_DIR, 'app.db'));
  const server = createServer();
  const directoryPicker = options.directoryPicker ?? new DirectoryPicker();
  let manager: RunManager | undefined;

  try {
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
    manager = new RunManager(store, () => settings.getRuntime(), logger, realpathSync(configuration.FLUX_DATA_DIR));
    const initialWorkspace =
      options.initialWorkspace === undefined ? configuration.FLUX_WORKSPACE_DIR : options.initialWorkspace;
    if (!manager.workspaces.list().length && initialWorkspace) manager.workspaces.create(initialWorkspace);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? configuration.PORT, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法获取本地服务端口。');
    const origins = [address.port, configuration.WEB_PORT].flatMap((port) => [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    const app = createApp({ manager, logger, origins, settings, directoryPicker });
    const webRoot = fileURLToPath(new URL('../../../web/dist', import.meta.url));
    app.use('*', serveStatic({ root: webRoot }));
    app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
    server.on('request', getRequestListener(app.fetch));
    const url = `http://127.0.0.1:${address.port}`;
    logger.info({ url, configured: settings.getSettings().configured }, 'Flux Agent ready');

    const runningManager = manager;
    let shutdownPromise: Promise<void> | undefined;
    return {
      url,
      shutdown(): Promise<void> {
        shutdownPromise ??= (async () => {
          const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          directoryPicker.cancel();
          await runningManager.shutdown();
          server.closeAllConnections();
          await closed;
          store.close();
        })();
        return shutdownPromise;
      },
    };
  } catch (error) {
    server.close();
    directoryPicker.cancel();
    await manager?.shutdown();
    store.close();
    throw error;
  }
}
