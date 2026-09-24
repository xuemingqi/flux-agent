import { expect, test } from '@playwright/test';

test('recalls a confirmed identity in a new read-only conversation without matching question keywords', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '长期记忆' }).click();
  await page.getByRole('button', { name: '添加记忆' }).click();
  await page.getByRole('textbox', { name: '记忆内容' }).fill('用户姓名：林舟，称呼：小林。');
  await page.getByRole('button', { name: '保存并启用' }).click();
  const card = page.locator('.memory-card').filter({ hasText: '用户姓名：林舟' });
  await expect(card).toContainText('已启用');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '仅可查看', exact: false }).click();
  await expect(page.getByRole('button', { name: '运行权限' })).toContainText('仅可查看');
  await page.getByRole('textbox', { name: '消息' }).fill('你记得我是谁吗');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('你是林舟');
  await page.locator('.context-details summary').click();
  await expect(page.locator('.context-details')).toContainText('用户姓名：林舟');
  await page.getByRole('textbox', { name: '消息' }).fill('查询我的称呼');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('用户姓名：林舟');
  await page.locator('[data-tool="search_memories"] > summary').click();
  await expect(page.locator('.tool-result-memory')).toContainText('用户姓名：林舟');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  await page.getByRole('button', { name: '长期记忆' }).click();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('confirms a model candidate, recalls it in a new conversation, and disables future retrieval', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('记住项目暗号');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('candidate');
  await page.getByRole('button', { name: '长期记忆' }).click();
  const card = page.locator('.memory-card').filter({ hasText: '项目暗号是 blue-sparrow' });
  await expect(card).toContainText('待确认');
  await expect(card.getByRole('button', { name: '查看来源会话' })).toBeVisible();
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('项目暗号是什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('没有可用的暗号记忆');
  await page.getByRole('button', { name: '长期记忆' }).click();
  await card.getByRole('button', { name: '确认并启用' }).click();
  await expect(card).toContainText('已启用');
  await page.reload();
  await page.getByRole('button', { name: '长期记忆' }).click();
  await expect(card).toContainText('v2');
  await page.screenshot({ path: '/tmp/flux-memory-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('项目暗号是什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('记忆中的暗号：blue-sparrow');
  await page.locator('.context-details summary').click();
  await expect(page.locator('.context-details')).toContainText('项目暗号是 blue-sparrow');
  await page.getByRole('button', { name: '长期记忆' }).click();
  await card.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(card).toContainText('已禁用');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('项目暗号是什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('没有可用的暗号记忆');
  await page.getByRole('button', { name: '长期记忆' }).click();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('adds, edits, and searches user memory and keeps native tool history after refresh', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '长期记忆' }).click();
  await page.getByRole('button', { name: '添加记忆' }).click();
  await page.getByRole('textbox', { name: '记忆内容' }).fill('测试部署使用 SQLite');
  await page.getByRole('button', { name: '保存并启用' }).click();
  const card = page.locator('.memory-card').filter({ hasText: '测试部署使用' });
  await expect(card).toContainText('已启用');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '记忆内容' }).fill('测试部署使用 PostgreSQL');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(card).toContainText('PostgreSQL');
  await page.getByRole('textbox', { name: '搜索记忆' }).fill('sqlite');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索记忆' }).fill('postgresql');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(card).toContainText('v2');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('读取测试文件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('工具返回');
  await page.reload();
  await page.getByRole('textbox', { name: '消息' }).fill('检查工具历史');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('已接收完整工具历史');
});

test('keeps the memory page and editor usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('button', { name: '长期记忆' }).click();
  await expect(page.getByRole('button', { name: '添加记忆' })).toBeVisible();
  await page.screenshot({ path: '/tmp/flux-memory-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '添加记忆' }).click();
  await expect(page.getByRole('textbox', { name: '记忆内容' })).toBeVisible();
  await page.screenshot({ path: '/tmp/flux-memory-editor-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
});
