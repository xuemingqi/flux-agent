import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个测试服务使用临时配置目录，不读取或覆盖用户真实的模型设置。
const directory = await mkdtemp(join(tmpdir(), 'flux-e2e-'));
const workspace = join(directory, 'workspace');
const dataDirectory = join(directory, 'data');
await mkdir(workspace);
await mkdir(join(workspace, 'second'));
await mkdir(join(workspace, 'third'));
await mkdir(join(workspace, 'fourth'));
await writeFile(join(workspace, 'hello.txt'), 'initial text\n');
await writeFile(
  join(workspace, 'README.md'),
  '# Preview fixture\n\npreview needle\n\n<script>window.previewXss = true</script>\n',
);
await writeFile(join(workspace, 'empty.txt'), '');
const child = spawn(process.execPath, ['apps/server/dist/bootstrap/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, FLUX_DATA_DIR: dataDirectory, FLUX_WORKSPACE_DIR: workspace },
});
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
child.once('exit', async (code) => {
  await rm(directory, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
