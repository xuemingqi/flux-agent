import { startServer } from './server.js';

const server = await startServer();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 5000).unref();
  await server.shutdown();
  clearTimeout(deadline);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
