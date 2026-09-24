import { expect, test } from '@playwright/test';
import { access } from 'node:fs/promises';

test('switches an unfinished answer immediately without waiting for the old response to finish', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('插话测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('正在生成初稿');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill('改成三点摘要');
  await page.getByRole('textbox', { name: '消息' }).press('Enter');
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('');
  await expect(page.locator('.markdown').last()).toContainText('已根据补充要求改成三点摘要');
  await expect(page.getByText('调整方向 · 已开始处理')).toHaveCount(1);
  await expect(page.getByText('调整方向 · 等待当前执行单元完成', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.markdown').last()).toContainText('已根据补充要求改成三点摘要');
  const runs = await page.evaluate(
    async () => (await (await fetch(`/api/threads/${localStorage.getItem('flux-thread')}`)).json()).runs,
  );
  expect(runs).toHaveLength(1);
  expect(runs[0].steering).toMatchObject([{ content: '改成三点摘要', status: 'applied' }]);
});

test('steers while awaiting approval without approving or replaying the write', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '工作区内修改', exact: false }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('拒绝测试修改');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const approval = page.getByRole('region', { name: '文件修改审批' });
  await expect(approval).toContainText('等待你的确认');
  const path = await approval.locator('.approval-path').innerText();
  await page.getByRole('textbox', { name: '消息' }).fill('不要修改，解释原因');
  await page.getByRole('button', { name: '调整方向', exact: true }).click();
  await expect(page.getByText('调整方向 · 等待当前执行单元完成', { exact: true })).toBeVisible();
  await expect(approval).toContainText('等待你的确认');
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('已取消修改，文件保持原样');
  await expect(approval).toHaveCount(1);
  await expect(access(path)).rejects.toThrow();
});

test('retries a lost steering acknowledgement after completion without creating a new turn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('插话测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('正在生成初稿');
  await page.route(
    '**/api/runs/*/steer',
    async (route) => {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort();
    },
    { times: 1 },
  );
  await page.getByRole('textbox', { name: '消息' }).fill('改成三点摘要');
  await page.getByRole('button', { name: '调整方向', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('改成三点摘要');
  await expect(page.locator('.markdown').last()).toContainText('已根据补充要求改成三点摘要');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('');
  const runs = await page.evaluate(
    async () => (await (await fetch(`/api/threads/${localStorage.getItem('flux-thread')}`)).json()).runs,
  );
  expect(runs).toHaveLength(1);
  expect(runs[0].steering).toHaveLength(1);
});

test('preserves rejected steering as a draft and labels pending input unprocessed when stopped', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '工作区内修改', exact: false }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('拒绝测试修改');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '文件修改审批' })).toContainText('等待你的确认');
  await page.route(
    '**/api/runs/*/steer',
    (route) => route.fulfill({ status: 409, json: { code: 'STEERING_CLOSED', message: '本轮已在结束，请重新发送。' } }),
    { times: 1 },
  );
  await page.getByRole('textbox', { name: '消息' }).fill('改成三点摘要');
  await page.getByRole('button', { name: '调整方向', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本轮已在结束');
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('改成三点摘要');
  await page.getByRole('button', { name: '调整方向', exact: true }).click();
  await expect(page.getByText('调整方向 · 等待当前执行单元完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByText('本轮结束前未处理，请重新发送')).toBeVisible();
  await page.reload();
  await expect(page.getByText('本轮结束前未处理，请重新发送')).toBeVisible();
});
