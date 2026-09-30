import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { rebuild } from '@electron/rebuild';

const require = createRequire(import.meta.url);
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const rootDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const appDirectory = join(projectDirectory, 'dist/app');

function run(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: projectDirectory, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`桌面命令退出：${signal ?? code}`));
    });
  });
}

async function prepareApplication() {
  const manifest = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
  const packageManager = process.env.npm_execpath;
  if (!packageManager || !process.env.npm_config_user_agent?.startsWith('pnpm/'))
    throw new Error('请通过 pnpm desktop:dev 或 pnpm desktop:build 运行。');

  await rm(appDirectory, { recursive: true, force: true });
  await mkdir(appDirectory, { recursive: true });
  await writeFile(
    join(appDirectory, 'package.json'),
    `${JSON.stringify(
      {
        ...manifest,
        name: 'flux-agent-desktop',
        productName: 'Flux Agent',
        version: manifest.version,
        description: 'Flux Agent desktop application',
        type: 'module',
        main: 'main.cjs',
        bin: undefined,
        files: undefined,
        scripts: undefined,
        publishConfig: undefined,
      },
      null,
      2,
    )}\n`,
  );
  // 独立 workspace 阻止打包器向上扫描；复制锁文件和依赖文件，避免改变 npm 版的安装状态和原生模块。
  await cp(join(rootDirectory, 'pnpm-lock.yaml'), join(appDirectory, 'pnpm-lock.yaml'));
  const workspaceConfiguration = await readFile(join(rootDirectory, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(
    join(appDirectory, 'pnpm-workspace.yaml'),
    `${workspaceConfiguration.replace(/^packages:\r?\n(?:[ \t].*\r?\n)*/m, 'packages: []\n')}\nverifyDepsBeforeRun: false\n`,
  );
  await run(
    process.execPath,
    [
      packageManager,
      'install',
      '--offline',
      '--frozen-lockfile',
      '--prod',
      '--ignore-scripts',
      '--config.package-import-method=copy',
    ],
    { cwd: appDirectory },
  );
  await cp(join(rootDirectory, 'dist'), join(appDirectory, 'dist'), { recursive: true });
  await cp(join(projectDirectory, 'resources/icon.png'), join(appDirectory, 'icon.png'));
  await build({
    entryPoints: [join(projectDirectory, 'src/main.ts')],
    outfile: join(appDirectory, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  });
  await build({
    entryPoints: [join(projectDirectory, 'src/backend.ts')],
    outfile: join(appDirectory, 'dist/apps/server/dist/bootstrap/main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: Object.keys(manifest.dependencies),
  });
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== 'start' && command !== 'package') throw new Error('桌面命令必须是 start 或 package。');
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('桌面版仅构建 macOS 和 Windows。');
  await prepareApplication();
  if (command === 'start') {
    const { version } = require('electron/package.json');
    await rebuild({
      buildPath: appDirectory,
      projectRootPath: appDirectory,
      electronVersion: version,
      onlyModules: ['better-sqlite3'],
    });
    await run(require('electron'), [appDirectory, ...arguments_], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
  } else {
    await run(
      process.execPath,
      [
        require.resolve('electron-builder/cli.js'),
        '--projectDir',
        appDirectory,
        '--config',
        join(projectDirectory, 'electron-builder.config.cjs'),
        ...arguments_,
        '--publish',
        'never',
      ],
      { cwd: appDirectory },
    );
  }
}

await main().catch((error) => {
  console.error(`Flux Agent desktop: ${error.message}`);
  process.exitCode = 1;
});
