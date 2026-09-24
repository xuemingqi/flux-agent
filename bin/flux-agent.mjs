#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';

const help = `Usage: flux-agent web [options]

Start the local Flux Agent web interface at http://127.0.0.1:3000.

Options:
  --port <number>      HTTP port (default: PORT or 3000)
  --workspace <path>   Initial workspace (default: FLUX_WORKSPACE_DIR or current directory)
  --data-dir <path>    Persistent data directory (default: FLUX_DATA_DIR or ~/.flux-agent)
  --env-file <path>    Load environment variables from a file
  -h, --help          Show this help
  -v, --version       Show the package version

Open the printed URL in your browser. Press Ctrl+C to stop.
Workspace options only apply when the data directory has no saved workspaces.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string' },
      workspace: { type: 'string' },
      'data-dir': { type: 'string' },
      'env-file': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(version);
    return;
  }
  if (!positionals.length) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'web') {
    throw new Error('Expected the "web" command. Run flux-agent --help for usage.');
  }

  if (values['env-file'] !== undefined) loadEnvFile(resolve(values['env-file']));
  if (values.port !== undefined) process.env.PORT = values.port;
  if (values['data-dir'] !== undefined) process.env.FLUX_DATA_DIR = resolve(values['data-dir']);
  // npx 的安装目录只存放程序，工作区始终由调用者的目录或显式配置决定。
  process.env.FLUX_WORKSPACE_DIR = resolve(values.workspace ?? process.env.FLUX_WORKSPACE_DIR ?? process.cwd());
  await import('../dist/apps/server/dist/bootstrap/main.js');
}

main().catch((error) => {
  console.error(`Flux Agent: ${error.message}`);
  process.exitCode = 1;
});
