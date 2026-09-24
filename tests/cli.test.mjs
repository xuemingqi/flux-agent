import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../bin/flux-agent.mjs', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('help and version work without starting the server; invalid commands fail', () => {
  for (const cliArguments of [[], ['--help'], ['web', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...cliArguments], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: flux-agent web/);
  }
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);
  for (const cliArguments of [['unknown'], ['web', 'extra'], ['web', '--unknown'], ['web', '--port', '0']]) {
    const result = spawnSync(process.execPath, [cli, ...cliArguments], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Flux Agent:/);
  }
});

test('web serves the built UI, migrates SQLite and uses the caller workspace outside the repository', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'flux-cli-'));
  const workspace = join(directory, 'workspace');
  const dataDirectory = join(directory, 'data');
  await mkdir(workspace);
  context.after(() => rm(directory, { recursive: true, force: true }));

  const portReservation = createServer();
  portReservation.listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const port = portReservation.address().port;
  await new Promise((resolve, reject) => portReservation.close((error) => (error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('MODEL_') || key.startsWith('FLUX_') || key === 'PORT' || key === 'WEB_PORT')
      delete environment[key];
  }
  await writeFile(join(workspace, 'test.env'), 'PORT=0\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    let output = '';
    const child = spawn(
      process.execPath,
      [cli, 'web', '--env-file', 'test.env', '--port', String(port), '--data-dir', dataDirectory],
      { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let stopped;
    try {
      await context.waitFor(
        async () => {
          assert.equal(child.exitCode, null, output);
          assert.ok((await fetch(origin)).ok);
        },
        { timeout: 15_000, interval: 50 },
      );
      const page = await fetch(origin);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const html = await page.text();
      const asset = html.match(/src="([^"]+\.js)"/)?.[1];
      assert.ok(asset, html);
      const assetResponse = await fetch(new URL(asset, origin));
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get('content-type'), /javascript/);
      assert.equal(await (await fetch(`${origin}/settings`)).text(), html);

      const sessionResponse = await fetch(`${origin}/api/session`, { headers: { 'x-flux-client': 'web' } });
      assert.equal(sessionResponse.status, 200);
      const session = await sessionResponse.json();
      assert.equal(session.configured, false);
      assert.equal(session.storage, 'sqlite');
      const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
      const workspacesResponse = await fetch(`${origin}/api/workspaces`, { headers: { cookie } });
      assert.equal(workspacesResponse.status, 200);
      const workspaces = await workspacesResponse.json();
      assert.equal(workspaces.length, 1);
      assert.equal(workspaces[0].rootPath, await realpath(workspace));
      assert.ok((await stat(join(dataDirectory, 'app.db'))).size > 0);
    } finally {
      child.kill('SIGTERM');
      stopped = await Promise.race([exited, setTimeout(7000, null, { ref: false })]);
      if (!stopped) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    assert.ok(stopped, `CLI did not stop gracefully: ${output}`);
    assert.equal(stopped[0], 0, output);
  }
});
