import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const releaseDirectory = fileURLToPath(new URL('../apps/desktop/release/', import.meta.url));
const executable =
  process.platform === 'darwin'
    ? join(releaseDirectory, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Flux Agent.app/Contents/MacOS/Flux Agent')
    : join(releaseDirectory, 'win-unpacked/Flux Agent.exe');

test(
  'packaged desktop serves the UI, selects a workspace, persists it and stops its backend',
  { timeout: 90_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'flux-desktop-'));
    const dataDirectory = join(directory, 'data');
    const workspace = join(directory, '项目 空格');
    await mkdir(workspace);
    context.after(() => rm(directory, { recursive: true, force: true }));
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (
        key.startsWith('MODEL_') ||
        key.startsWith('FLUX_') ||
        key === 'ELECTRON_RUN_AS_NODE' ||
        key === 'PORT' ||
        key === 'WEB_PORT'
      )
        delete environment[key];
    }
    environment.FLUX_DATA_DIR = dataDirectory;
    for (let attempt = 0; attempt < 2; attempt++) {
      const application = await _electron.launch({ executablePath: executable, env: environment, timeout: 30_000 });
      const process = application.process();
      const exited = once(process, 'exit');
      let output = '';
      process.stdout.on('data', (chunk) => {
        output += chunk;
      });
      process.stderr.on('data', (chunk) => {
        output += chunk;
      });
      let origin;
      try {
        const page = await application.firstWindow();
        await page.getByRole('button', { name: '添加工作区' }).waitFor();
        origin = new URL(page.url()).origin;
        assert.equal(new URL(origin).hostname, '127.0.0.1');
        assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
        assert.deepEqual(
          await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process })),
          {
            require: 'undefined',
            process: 'undefined',
          },
        );
        const session = await page.evaluate(async () => {
          const response = await fetch('/api/session', { headers: { 'x-flux-client': 'web' } });
          return response.json();
        });
        assert.equal(session.storage, 'sqlite');
        assert.equal(session.configured, false);
        const workspaces = await page.evaluate(async () => (await fetch('/api/workspaces')).json());
        if (attempt === 0) {
          assert.deepEqual(workspaces, []);
          await application.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
          }, workspace);
          await page.getByRole('button', { name: '添加工作区' }).click();
          await page.getByRole('button', { name: '项目 空格', exact: true }).waitFor();
        } else {
          assert.equal(workspaces.length, 1);
          assert.equal(workspaces[0].rootPath, await realpath(workspace));
        }
        assert.ok((await stat(join(dataDirectory, 'app.db'))).size > 0);
      } finally {
        await application.close();
      }
      const [code] = await exited;
      assert.equal(code, 0, output);
      await assert.rejects(fetch(origin));
    }
  },
);
