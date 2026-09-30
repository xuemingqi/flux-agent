import { startServer } from '../../server/src/bootstrap/server.js';
import { DesktopDirectoryPicker } from './directory-picker.js';
import type { HostMessage } from './messages.js';

async function main(): Promise<void> {
  const port = process.parentPort;
  const directoryPicker = new DesktopDirectoryPicker(port);
  const starting = startServer({ port: 0, initialWorkspace: null, directoryPicker });
  let stopping = false;
  port.on('message', ({ data }: { data: HostMessage }) => {
    if (data.type !== 'shutdown' || stopping) return;
    stopping = true;
    void starting
      .then(async (server) => {
        await server.shutdown();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
  const server = await starting;
  if (!stopping) port.postMessage({ type: 'ready', url: server.url });
}

void main().catch((error: unknown) => {
  console.error('Flux Agent 后台启动失败。', error);
  process.exit(1);
});
