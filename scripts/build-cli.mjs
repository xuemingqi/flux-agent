import { cp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });

// 保留后端入口的目录深度，使页面与 SQLite 迁移继续使用现有的相对路径。
// 仅合并本项目模块；第三方依赖由 npm 安装，尤其不能打包本机的 SQLite 原生二进制。
await build({
  absWorkingDir: root,
  entryPoints: ['apps/server/dist/bootstrap/main.js'],
  outfile: 'dist/apps/server/dist/bootstrap/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: Object.keys(manifest.dependencies),
  logLevel: 'info',
});
await cp(new URL('../apps/web/dist/', import.meta.url), new URL('../dist/apps/web/dist/', import.meta.url), {
  recursive: true,
});
await cp(
  new URL('../apps/server/drizzle/', import.meta.url),
  new URL('../dist/apps/server/drizzle/', import.meta.url),
  {
    recursive: true,
  },
);
