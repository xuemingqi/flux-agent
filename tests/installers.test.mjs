import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const registry = 'https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/';

async function createEnvironment(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'flux-installer-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binaries = join(directory, 'bin');
  const nodeBinaries = join(directory, 'node24');
  const nvmDirectory = join(directory, 'custom nvm');
  const log = join(directory, 'commands.log');
  await Promise.all([binaries, nodeBinaries, nvmDirectory].map((path) => mkdir(path)));
  await writeFile(log, '');

  async function executable(directory, name, body) {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/bash\n${body}\n`);
    await chmod(path, 0o755);
  }

  for (const name of ['bash', 'mkdir', 'mktemp', 'cp', 'rm']) {
    const located = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    assert.equal(located.status, 0, located.stderr);
    await symlink(located.stdout.trim(), join(binaries, name));
  }
  const version = options.version === undefined ? 'v24.1.0' : options.version;
  if (version !== null) await executable(binaries, 'node', `echo '${version}'`);
  await executable(nodeBinaries, 'node', 'echo v24.2.0');
  await executable(
    binaries,
    'npm',
    'if [ "$1" = "--version" ]; then echo 11.0.0; exit; fi\nprintf "%s\\n" "$@" >> "$FLUX_TEST_LOG"\nexit "${FLUX_TEST_NPM_EXIT:-0}"',
  );
  if (!options.missingNpx) {
    await executable(binaries, 'npx', 'printf "%s\\n" npx "$@" >> "$FLUX_TEST_LOG"\nexit "${FLUX_TEST_NPX_EXIT:-0}"');
  }

  const nvm = `nvm() {
  printf 'nvm %s %s\\n' "$1" "$2" >> "$FLUX_TEST_LOG"
  if [ "\${FLUX_TEST_NVM_EXIT:-0}" -ne 0 ]; then return "$FLUX_TEST_NVM_EXIT"; fi
  export PATH="$FLUX_TEST_NODE_BIN:$PATH"
}
`;
  if (!options.download) await writeFile(join(nvmDirectory, 'nvm.sh'), nvm);
  const nvmFixture = join(directory, 'nvm-fixture.sh');
  await writeFile(nvmFixture, nvm);
  const download = `printf 'download\\n' >> "$FLUX_TEST_LOG"
if [ "\${FLUX_TEST_DOWNLOAD_EXIT:-0}" -ne 0 ]; then exit "$FLUX_TEST_DOWNLOAD_EXIT"; fi
if [ "$1" = '-fsSL' ]; then target="$4"; else target="$2"; fi
printf 'cp "$FLUX_TEST_NVM_FIXTURE" "$NVM_DIR/nvm.sh"\\n' > "$target"`;
  await executable(binaries, options.downloader ?? 'curl', download);

  const env = {
    PATH: binaries,
    HOME: directory,
    TMPDIR: directory,
    NVM_DIR: nvmDirectory,
    FLUX_TEST_LOG: log,
    FLUX_TEST_NODE_BIN: nodeBinaries,
    FLUX_TEST_NVM_FIXTURE: nvmFixture,
    ...options.env,
  };
  return {
    run: (...args) => spawnSync('/bin/bash', [installer, ...args], { env, cwd: directory, encoding: 'utf8' }),
    runPiped: async () =>
      spawnSync('/bin/bash', [], {
        env,
        cwd: directory,
        encoding: 'utf8',
        input: await readFile(installer, 'utf8'),
      }),
    log: async () => (await readFile(log, 'utf8')).trim().split('\n'),
  };
}

const shellOptions = { skip: process.platform === 'win32' };

for (const version of ['v24.0.0', 'v26.8.2']) {
  test(
    `Bash reuses Node ${version}, configures only the scope, and forwards CLI arguments`,
    shellOptions,
    async (context) => {
      const environment = await createEnvironment(context, { version });
      const result = environment.run('--port', '3100', '--workspace', '/a directory/project');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await environment.log(), [
        'config',
        'set',
        '@yonyeyy:registry',
        registry,
        '--location=user',
        'npx',
        '--yes',
        '@yonyeyy/flux-agent@latest',
        'web',
        '--port',
        '3100',
        '--workspace',
        '/a directory/project',
      ]);
    },
  );
}

for (const version of [null, 'v22.10.0', 'invalid']) {
  test(
    `Bash installs Node 24 using existing nvm when Node is ${version ?? 'missing'}`,
    shellOptions,
    async (context) => {
      const environment = await createEnvironment(context, { version });
      const result = environment.run();
      assert.equal(result.status, 0, result.stderr);
      const commands = await environment.log();
      assert.deepEqual(commands.slice(0, 2), ['nvm install 24', 'nvm use 24']);
      assert.ok(commands.includes('npx'));
    },
  );
}

for (const downloader of ['curl', 'wget']) {
  test(`Bash bootstraps nvm through ${downloader} when read from stdin`, shellOptions, async (context) => {
    const environment = await createEnvironment(context, { version: null, download: true, downloader });
    const result = await environment.runPiped();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await environment.log()).slice(0, 3), ['download', 'nvm install 24', 'nvm use 24']);
  });
}

for (const [name, options] of [
  ['download failure', { version: null, download: true, env: { FLUX_TEST_DOWNLOAD_EXIT: '22' } }],
  ['Node installation failure', { version: 'v22.0.0', env: { FLUX_TEST_NVM_EXIT: '5' } }],
  ['registry configuration failure', { env: { FLUX_TEST_NPM_EXIT: '13' } }],
  ['missing npx', { missingNpx: true }],
]) {
  test(`Bash does not launch Flux Agent after ${name}`, shellOptions, async (context) => {
    const environment = await createEnvironment(context, options);
    const result = environment.run();
    assert.notEqual(result.status, 0);
    assert.ok(!(await environment.log()).includes('npx'));
  });
}

test('Bash returns the Flux Agent process exit code', shellOptions, async (context) => {
  const environment = await createEnvironment(context, { env: { FLUX_TEST_NPX_EXIT: '7' } });
  assert.equal(environment.run().status, 7);
});
