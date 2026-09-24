import { expect, test } from '@playwright/test';

test('sends multiple turns through LangChain and renders safe Markdown', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('fixture-model')).toBeVisible();
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('你好');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('这是第 1 轮回复。', { exact: false })).toBeVisible();
  await expect(page.getByText('18 tokens')).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill('继续');
  await page.getByRole('textbox', { name: '消息' }).press('Enter');
  await expect(page.getByText('这是第 2 轮回复。', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => 'fluxXss' in window)).toBe(false);
  await page.reload();
  await expect(page.getByText('这是第 2 轮回复。', { exact: false })).toBeVisible();
});

test('reconnects to an active run after refresh and stops the upstream request', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('慢速回答');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.markdown').last()).toContainText('慢速输出');
  await page.reload();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('.markdown').last()).toContainText('慢速输出');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
});

test('shows sanitized model errors and allows a new turn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('模拟错误');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('alert')).toContainText('模型鉴权失败');
  await expect(page.locator('body')).not.toContainText('fixture-key');
  await page.getByRole('textbox', { name: '消息' }).fill('重新开始');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('这是第 1 轮回复。', { exact: false })).toBeVisible();
});

test('shows real reasoning and tool results in chronological order and restores the trace after refresh', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('查询当前时间');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('查询完成。当前时间：', { exact: false })).toBeVisible();
  await expect(page.getByText('36 tokens')).toBeVisible();
  const steps = page.locator('.run-steps').last();
  await expect(steps.locator(':scope > *')).toHaveCount(4);
  await expect(steps.locator(':scope > *').nth(0)).toHaveClass(/reasoning-step/);
  await expect(steps.locator(':scope > *').nth(1)).toContainText('我先查询一下');
  await expect(steps.locator(':scope > *').nth(2)).toHaveClass(/tool-step/);
  await page.locator('.reasoning-step summary').click();
  await expect(page.locator('.reasoning-content')).toHaveText('我会先读取当前时间，再根据工具结果回答。');
  await page.locator('[data-tool="get_current_time"] > summary').click();
  await expect(page.locator('[data-tool="get_current_time"] .tool-detail')).toContainText('时区');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  await expect(page.locator('.tool-step')).toHaveClass(/succeeded/);
  await page.getByRole('button', { name: /思考与执行/ }).click();
  await expect(page.locator('.tool-step')).toHaveCount(0);
  await expect(page.getByText('查询完成。当前时间：', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: /轨迹/ }).click();
  await expect(page.locator('.reasoning-content')).toBeVisible();
  await expect(page.locator('[data-tool="get_current_time"] .tool-detail')).toContainText('时区');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  await expect(page.locator('.trace-run')).toContainText('查询完成');
});

test('restores streamed reasoning without answer text and closes it on cancellation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('慢速思考');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.reasoning-step summary')).toContainText('先梳理问题');
  await page.reload();
  await expect(page.locator('.reasoning-step summary')).toContainText('先梳理问题');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-indicator')).toHaveCount(0);
});

test('keeps navigation and the composer usable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill('查询当前时间');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('查询完成。当前时间：', { exact: false })).toBeVisible();
  await page.locator('[data-tool="get_current_time"] > summary').click();
  await expect(page.locator('[data-tool="get_current_time"] .tool-detail')).toContainText('时区');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
