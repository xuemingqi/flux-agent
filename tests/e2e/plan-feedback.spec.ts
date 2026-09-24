import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
});

test('shows a tool-updated plan and persists editable feedback across reloads', async ({ page }) => {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('按计划读取测试文件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const plan = page.getByLabel('任务计划', { exact: true });
  await expect(page.getByText('已按计划读取并整理测试文件。', { exact: true })).toBeVisible();
  await expect(plan).toContainText('2/2 已完成');
  await plan.locator('summary').click();
  await expect(plan.locator('li')).toHaveCount(2);
  await expect(plan.locator('li').first()).toHaveText(/读取测试文件已完成/);
  await page.getByRole('button', { name: '有帮助', exact: true }).click();
  await expect(page.getByRole('button', { name: '有帮助', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '补充意见', exact: true }).click();
  await page.getByRole('textbox', { name: '反馈意见' }).fill('下次请同时标明文件路径。');
  await page.getByRole('button', { name: '保存反馈', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看反馈', exact: true })).toBeVisible();
  await page.reload();
  await expect(plan).toContainText('2/2 已完成');
  await expect(page.getByRole('button', { name: '有帮助', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '查看反馈', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '反馈意见' })).toHaveValue('下次请同时标明文件路径。');
  await page.getByRole('textbox', { name: '反馈意见' }).fill('请补充来源。');
  await page.getByRole('button', { name: '保存反馈', exact: true }).click();
  await page.getByRole('button', { name: '需改进', exact: true }).click();
  await expect(page.getByRole('button', { name: '需改进', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '撤回反馈', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '需改进', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: '查看反馈', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤回反馈', exact: true })).toHaveCount(0);
});

test('streams and reconnects to an active plan and leaves steps incomplete after stopping', async ({ page }) => {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('计划中途停止');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const plan = page.getByLabel('任务计划', { exact: true });
  await expect(plan).toContainText('0/2 已完成');
  await expect(plan.locator('li').first()).toContainText('进行中');
  await expect(page.getByRole('button', { name: '有帮助', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(plan).toContainText('0/2 已完成');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(plan).toContainText('有未完成步骤');
  await expect(plan.locator('li').first()).toContainText('未完成');
  await expect(plan.locator('.spinner')).toHaveCount(0);
  await page.reload();
  await expect(plan).toContainText('有未完成步骤');
  await expect(page.getByRole('button', { name: '有帮助', exact: true })).toBeVisible();
});
