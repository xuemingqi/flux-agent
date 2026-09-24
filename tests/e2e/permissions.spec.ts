import { expect, test } from '@playwright/test';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

test('reads real workspace files and refreshes a pending approval before writing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('工作区内修改');
  await page.getByRole('textbox', { name: '消息' }).fill('读取测试文件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('initial text');
  const readStep = page.locator('[data-tool="read_file"]');
  await expect(readStep).toContainText('读取成功');
  await readStep.click();
  await expect(readStep.locator('pre, .tool-detail')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '文件预览' }).locator('.file-code')).toContainText(
    'initial text',
  );
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('修改测试文件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByRole('region', { name: '文件修改审批' });
  await expect(card).toContainText('等待你的确认');
  const path = await card.locator('.approval-path').innerText();
  expect(await readFile(path, 'utf8')).toBe('initial text\n');
  await expect(page.getByRole('button', { name: '运行权限' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('工作区内修改');
  await card.getByRole('button', { name: '查看修改前后内容' }).click();
  await expect(page.locator('.file-change-comparison')).toContainText('initial text');
  await expect(page.locator('.file-change-comparison')).toContainText('approved content');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByRole('button', { name: '允许本次修改' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.markdown').last()).toContainText('written');
  expect(await readFile(path, 'utf8')).toBe('approved content\n');
  await page.reload();
  await expect(card).toHaveCount(0);
  await page.locator('[data-tool="write_file"]').click();
  await expect(page.locator('.file-change-comparison')).toContainText('initial text');
  await expect(page.locator('.file-change-comparison')).toContainText('approved content');
  await expect(page.getByText('SQLite 已持久化')).toBeVisible();
});

test('denies a file change and requires explicit full-access confirmation before Shell', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '工作区内修改', exact: false }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('拒绝测试修改');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByRole('region', { name: '文件修改审批' });
  await expect(card).toContainText('等待你的确认');
  const path = await card.locator('.approval-path').innerText();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.markdown').last()).toContainText('APPROVAL_DENIED');
  await expect(access(path)).rejects.toThrow();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '完全权限', exact: false }).click();
  await expect(page.getByRole('dialog')).toContainText('没有容器隔离');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('工作区内修改');
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '完全权限', exact: false }).click();
  await page.getByRole('button', { name: '确认开启完全权限' }).click();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('完全权限');
  await page.getByRole('textbox', { name: '消息' }).fill('运行测试命令');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('command-ok');
  const commandStep = page.locator('[data-tool="run_command"]');
  await commandStep.locator(':scope > summary').click();
  await expect(commandStep.locator('.tool-log')).toBeVisible();
  await expect(commandStep.locator('.tool-log')).toContainText('command-ok');
  await expect(commandStep.locator('.tool-command-bar code')).toHaveText('printf command-ok');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  await page.reload();
  await commandStep.locator(':scope > summary').click();
  await expect(commandStep.locator('.tool-command-bar code')).toHaveText('printf command-ok');
  await expect(commandStep.locator('.tool-log')).toContainText('command-ok');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
});

test('opens a second workspace and isolates its conversation list', async ({ page }) => {
  await page.goto('/');
  const first = page.getByRole('region', { name: '工作区 workspace', exact: true });
  // Fixture 的第二个目录在同一临时目录，独立于用户真实工作区。
  const root = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces');
    const workspaces = await response.json();
    return workspaces[0].rootPath as string;
  });
  await page.route('**/api/workspaces/choose', async (route) => {
    const response = await page.request.post('/api/workspaces', {
      headers: route.request().headers(),
      data: { rootPath: join(root, 'second') },
    });
    await route.fulfill({ json: { workspace: await response.json() } });
  });
  await page.getByRole('button', { name: '添加工作区' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const second = page.getByRole('region', { name: '工作区 second', exact: true });
  await expect(second.getByText('你的对话会出现在这里')).toBeVisible();
  await expect(first).toBeVisible();
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('工作区内修改');
  await first.getByRole('button', { name: 'workspace', exact: true }).click();
  await expect(first.getByRole('button', { name: 'workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('navigation', { name: '对话记录' }).getByRole('button').first()).toBeVisible();
});
