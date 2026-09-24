import { expect, test } from '@playwright/test';

test('renames and deletes a conversation with a hover menu, preserving sibling conversations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('会话操作测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('第 1 轮回复');
  const id = await page.evaluate(() => localStorage.getItem('flux-thread'));
  const row = page.locator('.thread-row').filter({ has: page.locator('.thread-select', { hasText: '会话操作测试' }) });
  await page.getByRole('heading').first().hover();
  await page.getByRole('textbox', { name: '消息' }).focus();
  await expect(row.locator('.thread-actions')).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(row.locator('.thread-actions')).toHaveCSS('opacity', '1');
  await row.getByRole('button', { name: '会话“会话操作测试”的操作' }).click();
  await row.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '会话名称' }).fill('重命名后的会话');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByRole('heading', { name: '重命名后的会话', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.markdown').last()).toContainText('第 1 轮回复');
  const renamed = page
    .locator('.thread-row')
    .filter({ has: page.locator('.thread-select', { hasText: '重命名后的会话' }) });
  await renamed.hover();
  await renamed.getByRole('button', { name: '会话“重命名后的会话”的操作' }).click();
  await renamed.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(renamed).toHaveCount(0);
  expect(await page.evaluate(async (id) => (await fetch(`/api/threads/${id}`)).status, id)).toBe(404);
  await page.reload();
  await expect(renamed).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shows live children beside their delegation and restores progress and results after refresh', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('多 Agent 测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const children = page.getByRole('region', { name: '子 Agent 任务' });
  await expect(page.locator('.assistant-run > .run-steps > .tool-step + .subagent-tasks')).toHaveCount(1);
  await expect(children).toContainText('1/2 已完成');
  await expect(page.getByLabel('子 Agent 分析 B', { exact: true }).locator('summary').first()).toContainText(
    '正在思考',
  );
  await page.reload();
  await expect(children).toContainText('1/2 已完成');
  await expect(page.getByRole('status')).toContainText('正在等待子 Agent');
  await request.post('http://127.0.0.1:4319/release-subagents');
  await expect(page.locator('.assistant-run > .run-steps .markdown').last()).toContainText('主 Agent 已汇总');
  await expect(children).toContainText('2/2 已完成');
  await page.getByLabel('子 Agent 分析 A', { exact: true }).locator('summary').first().click();
  await expect(children.locator('[data-tool="read_file"]').first()).toBeVisible();
  await children.locator('[data-tool="read_file"]').first().click();
  await expect(page.locator('.tool-inspector .file-code')).not.toBeEmpty();
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(children).toContainText('子任务读取 A完成');
  // 子任务的工具和回答只展示在各自的轨迹中。
  await expect(page.locator('.assistant-run > .run-steps > .tool-step')).toHaveCount(1);
  await page.reload();
  await expect(children).toContainText('2/2 已完成');
  const runs = await page.evaluate(
    async () => (await (await fetch(`/api/threads/${localStorage.getItem('flux-thread')}`)).json()).runs,
  );
  expect(runs[0].subagents).toHaveLength(2);
  expect(runs[0].subagents.every((task: { messages: unknown[] }) => task.messages.length === 4)).toBe(true);
});

test('automatically summarizes oversized history and reuses it after refresh', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('历史任务代号 orchid。' + '历史说明'.repeat(4500));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息' }).fill('复述历史代号');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('历史代号是 orchid');
  await expect(page.locator('.context-details > summary').last()).toContainText('已压缩');
  await page.reload();
  await expect(page.locator('.context-details > summary').last()).toContainText('已压缩');
  await page.getByRole('textbox', { name: '消息' }).fill('复述历史代号');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('历史代号是 orchid');
});

test('shows compaction progress while summarization is waiting and restores it after refresh', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page
    .getByRole('textbox', { name: '消息' })
    .fill('等待压缩测试，历史任务代号 orchid。' + '历史说明'.repeat(4500));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息' }).fill('复述历史代号');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在压缩上下文 · 0/');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('正在压缩上下文 · 0/');
  await request.post('http://127.0.0.1:4319/release-compression');
  await expect(page.locator('.markdown').last()).toContainText('历史代号是 orchid');
  await expect(page.getByRole('status')).toHaveCount(0);
});
