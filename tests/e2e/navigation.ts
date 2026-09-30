import type { Page } from '@playwright/test';

export async function openSettingsPage(page: Page, name: '长期记忆' | '模型设置') {
  if (!(await page.getByRole('button', { name: '设置', exact: true }).isVisible()))
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
