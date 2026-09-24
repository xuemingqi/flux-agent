import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function send(page: Page, message: string) {
  const count = await page.locator('.conversation-turn').count();
  await page.getByRole('textbox', { name: '消息' }).fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(count + 1);
  await expect(page.locator('.conversation-turn').last().locator('.run-detail')).toContainText('已完成');
}
async function thread(page: Page) {
  return page.evaluate(async () => (await fetch(`/api/threads/${localStorage.getItem('flux-thread')}`)).json());
}

test('opens file snapshots beside chat with tabs and safe Markdown, without changing model history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await send(page, '读取说明文件');
  const before = await thread(page);
  const row = page.locator('[data-tool="read_file"]').last();
  await row.click();
  const inspector = page.getByRole('complementary', { name: '文件预览' });
  await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
  await expect(row.locator('pre, details')).toHaveCount(0);
  await expect(page.getByText('查看返回内容', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => 'previewXss' in window)).toBe(false);
  const left = await page.locator('main').boundingBox();
  const right = await inspector.boundingBox();
  expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width - 1);
  expect(Math.abs(right!.width - left!.width)).toBeLessThan(2);
  await inspector.getByRole('button', { name: '查看源码', exact: true }).click();
  await expect(inspector.locator('.file-code')).toContainText('# Preview fixture');
  expect((await thread(page)).messages).toEqual(before.messages);
  expect((await thread(page)).runs).toEqual(before.runs);
  await send(page, '读取空文件');
  await page.locator('[data-tool="read_file"]').last().click();
  await expect(inspector.getByRole('tab')).toHaveCount(2);
  await expect(inspector.locator('.file-code code')).toHaveText('');
  await inspector.getByRole('tab', { name: 'README.md', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
  await inspector.getByRole('button', { name: '展开预览' }).click();
  await expect(inspector).toHaveClass(/expanded/);
  await inspector.getByRole('button', { name: '恢复分屏' }).click();
  await inspector.getByRole('button', { name: '关闭 README.md', exact: true }).click();
  await expect(inspector.getByRole('tab', { name: 'empty.txt' })).toHaveAttribute('aria-selected', 'true');
  await inspector.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('[data-tool="read_file"]').last()).toBeFocused();
  await page.locator('[data-tool="read_file"]').last().click();
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
});

test('opens files from directory and search, highlights matching lines, and refreshes only the preview', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await send(page, '列出测试目录');
  await page.locator('[data-tool="list_directory"] > summary').click();
  const inspector = page.getByRole('complementary', { name: '文件预览' });
  await expect(inspector).toHaveCount(0);
  await page
    .locator('[data-tool="list_directory"]')
    .getByRole('button', { name: 'README.md 文件', exact: true })
    .click();
  await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
  await send(page, '搜索测试文件');
  await page.locator('[data-tool="search_files"] > summary').click();
  await expect(inspector.getByRole('tab')).toHaveCount(1);
  await page.locator('[data-tool="search_files"] .search-match').filter({ hasText: 'README.md' }).click();
  await expect(inspector.locator('.code-line.highlighted')).toContainText('preview needle');
  await expect(inspector.locator('.code-line.highlighted')).toHaveAttribute('data-line', '3');
  const filePath = await inspector.locator('.inspector-path').innerText();
  const original = await readFile(filePath, 'utf8');
  const before = await thread(page);
  try {
    await writeFile(filePath, '# Changed on disk\n');
    await inspector.getByRole('button', { name: '读取当前文件' }).click();
    await expect(inspector.locator('.file-code')).toContainText('Changed on disk');
    expect((await thread(page)).messages).toEqual(before.messages);
    expect((await thread(page)).runs).toEqual(before.runs);
  } finally {
    await writeFile(filePath, original);
  }
  await inspector.getByRole('button', { name: '关闭预览', exact: true }).click();
  await send(page, '读取失败测试');
  await page.locator('[data-tool="read_file"] > summary').click();
  await expect(page.locator('.tool-result-error')).toContainText('路径不存在');
  await expect(inspector).toHaveCount(0);
});

test('keeps the original read snapshot when the file changes and shows preview failures without losing it', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await send(page, '读取说明文件');
  await page.locator('[data-tool="read_file"]').click();
  const inspector = page.locator('.tool-inspector');
  const root = await page.evaluate(async () => (await (await fetch('/api/workspaces')).json())[0].rootPath);
  const filePath = join(root, 'README.md');
  const original = await readFile(filePath, 'utf8');
  try {
    await writeFile(filePath, '# Updated version\n');
    await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
    await inspector.getByRole('button', { name: '读取当前文件' }).click();
    await expect(inspector.getByRole('heading', { name: 'Updated version' })).toBeVisible();
    await page.locator('[data-tool="read_file"]').click();
    await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
    await page.route('**/api/threads/*/file?*', (route) =>
      route.fulfill({ status: 403, json: { code: 'PATH_DENIED', message: '预览访问被拒绝' } }),
    );
    await inspector.getByRole('button', { name: '读取当前文件' }).click();
    await expect(inspector.getByRole('alert')).toContainText('预览访问被拒绝');
    await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
  } finally {
    await writeFile(filePath, original);
  }
});

test('uses the screen for file preview on mobile and returns focus to the file event on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await send(page, '读取说明文件');
  const row = page.locator('[data-tool="read_file"]');
  await row.click();
  const inspector = page.locator('.tool-inspector');
  await expect(inspector.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();
  const bounds = await inspector.boundingBox();
  expect(bounds!.width).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inspector.getByRole('button', { name: '关闭预览', exact: true }).press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(row).toBeFocused();
});
