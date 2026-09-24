import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test('shows project actions on hover and deletes conversations when removing their workspace', async ({ page }) => {
  await page.goto('/');
  const created = await page.evaluate(async () => {
    const { token } = await (await fetch('/api/session', { headers: { 'x-flux-client': 'web' } })).json();
    const workspaces = await (await fetch('/api/workspaces')).json();
    return (
      await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-flux-token': token },
        body: JSON.stringify({ rootPath: `${workspaces[0].rootPath}/fourth` }),
      })
    ).json();
  });
  await page.reload();
  const group = page.locator(`[data-workspace-id="${created.id}"]`);
  await expect(group).toBeVisible();
  await page.getByRole('heading').first().hover();
  await expect(group.locator('.workspace-actions')).toHaveCSS('opacity', '0');
  await group.locator('.workspace-group-heading').hover();
  await expect(group.locator('.workspace-actions')).toHaveCSS('opacity', '1');
  await group.getByRole('button', { name: '在“fourth”中新建会话' }).click();
  await expect(group.getByRole('button', { name: 'fourth', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '消息' }).fill('操作菜单保留的会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('第 1 轮回复');
  const deletedThreadId = await page.evaluate(() => localStorage.getItem('flux-thread'));
  await group.locator('.workspace-group-heading').hover();
  await group.getByRole('button', { name: '工作区“fourth”的操作' }).click();
  await group.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '工作区名称' }).fill('自定义项目');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(group.getByRole('button', { name: '自定义项目', exact: true })).toHaveAttribute(
    'title',
    created.rootPath,
  );
  await page.reload();
  await group.locator('.workspace-group-heading').hover();
  await group.getByRole('button', { name: '工作区“自定义项目”的操作' }).click();
  await group.getByRole('button', { name: '移除工作区', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('永久删除其中的全部会话');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(group).toBeVisible();
  await expect(group.locator('.thread-select').filter({ hasText: '操作菜单保留的会话' })).toBeVisible();
  await group.getByRole('button', { name: '工作区“自定义项目”的操作' }).click();
  await group.getByRole('button', { name: '移除工作区', exact: true }).click();
  await page.getByRole('button', { name: '确认移除' }).click();
  await expect(group).toHaveCount(0);
  const ungrouped = page.getByRole('region', { name: '工作区 未分组' });
  await expect(ungrouped).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '操作菜单保留的会话' })).toHaveCount(0);
  expect(await page.evaluate(async (id) => (await fetch(`/api/threads/${id}`)).status, deletedThreadId)).toBe(404);
  await page.reload();
  await expect(page.getByRole('button', { name: '添加工作区' })).toBeEnabled();
  await expect(ungrouped).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '操作菜单保留的会话' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.route('**/api/workspaces/choose', async (route) => {
    const response = await page.request.post('/api/workspaces', {
      headers: { 'x-flux-token': route.request().headers()['x-flux-token']! },
      data: { rootPath: created.rootPath },
    });
    expect(response.ok()).toBe(true);
    await route.fulfill({ json: { workspace: await response.json() } });
  });
  await page.getByRole('button', { name: '添加工作区' }).click();
  await expect(group.getByText('你的对话会出现在这里')).toBeVisible();
  await expect(group.locator('.thread-select').filter({ hasText: '操作菜单保留的会话' })).toHaveCount(0);
  await expect(group.getByRole('button', { name: '自定义项目', exact: true })).toBeVisible();
  await expect(ungrouped).toHaveCount(0);
});

test('collapses conversations without closing the current chat and leaves selection unchanged when the picker cancels', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  const current = page.getByRole('region', { name: '工作区 workspace', exact: true });
  await current.getByRole('button', { name: '折叠工作区会话' }).click();
  await expect(current.getByRole('navigation', { name: '对话记录' })).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(current.getByRole('button', { name: '展开工作区会话' })).toHaveAttribute('aria-expanded', 'false');
  await current.getByRole('button', { name: '展开工作区会话' }).click();
  await expect(current.getByRole('navigation', { name: '对话记录' })).toBeVisible();
  await page.route('**/api/workspaces/choose', (route) => route.fulfill({ json: { workspace: null } }));
  const dialogRequest = page.waitForRequest('**/api/workspaces/choose');
  await page.getByRole('button', { name: '添加工作区' }).click();
  expect((await dialogRequest).method()).toBe('POST');
  await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加工作区' })).toBeEnabled();
  await expect(current.getByRole('button', { name: 'workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps all workspace groups and their conversations after adding, switching, and refreshing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('原工作区的保留会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('第 1 轮回复');
  const initialCount = await page.locator('.workspace-group').count();
  const first = page.getByRole('region', { name: '工作区 workspace', exact: true });
  const added = page.getByRole('region', { name: '工作区 third', exact: true });
  const root = await page.evaluate(async () => {
    const workspaces = await (await fetch('/api/workspaces')).json();
    return workspaces[0].rootPath as string;
  });
  // 仅替代系统目录选择边界；目录注册、SQLite 保存和列表刷新仍使用真实接口。
  await page.route('**/api/workspaces/choose', async (route) => {
    const response = await page.request.post('/api/workspaces', {
      headers: { 'x-flux-token': route.request().headers()['x-flux-token']! },
      data: { rootPath: join(root, 'third') },
    });
    expect(response.ok()).toBe(true);
    await route.fulfill({ json: { workspace: await response.json() } });
  });
  await page.getByRole('button', { name: '添加工作区' }).click();
  await expect(page.locator('.workspace-group')).toHaveCount(initialCount + 1);
  await expect(first.locator('.thread-select').filter({ hasText: '原工作区的保留会话' })).toBeVisible();
  await expect(added.getByRole('button', { name: 'third', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('新工作区的独立会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('第 1 轮回复');
  await expect(added.locator('.thread-select').filter({ hasText: '新工作区的独立会话' })).toBeVisible();
  await expect(first.locator('.thread-select').filter({ hasText: '新工作区的独立会话' })).toHaveCount(0);
  await expect(added.locator('.thread-select').filter({ hasText: '原工作区的保留会话' })).toHaveCount(0);
  await first.getByRole('button', { name: '折叠工作区会话' }).click();
  await expect(first.getByRole('navigation')).not.toBeVisible();
  await expect(added.getByRole('navigation')).toBeVisible();
  await added.getByRole('button', { name: '折叠工作区会话' }).click();
  await added.getByRole('button', { name: '展开工作区会话' }).click();
  await expect(first.getByRole('navigation')).not.toBeVisible();
  await first.getByRole('button', { name: '展开工作区会话' }).click();
  await first.locator('.thread-select').filter({ hasText: '原工作区的保留会话' }).click();
  await expect(first.getByRole('button', { name: 'workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: '原工作区的保留会话', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.workspace-group')).toHaveCount(initialCount + 1);
  await expect(first.getByRole('button', { name: 'workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: '原工作区的保留会话', exact: true })).toBeVisible();
  await expect(added.locator('.thread-select').filter({ hasText: '新工作区的独立会话' })).toBeVisible();
  await page.getByRole('button', { name: '添加工作区' }).click();
  await expect(added.getByRole('button', { name: 'third', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.workspace-group')).toHaveCount(initialCount + 1);
  await expect(first.locator('.thread-select').filter({ hasText: '原工作区的保留会话' })).toBeVisible();
});
