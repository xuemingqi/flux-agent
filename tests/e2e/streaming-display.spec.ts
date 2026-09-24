import { expect, test, type Locator, type Page } from '@playwright/test';

async function startRun(page: Page, question: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill(question);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function advance(page: Page, question: string, delta: Record<string, string>) {
  const response = await page.request.post('http://127.0.0.1:4319/advance-display', { data: { question, delta } });
  expect(response.ok()).toBe(true);
}

async function distanceToBottom(viewport: Locator) {
  return viewport.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
}

test('lets readers scroll up during streaming and resumes following only at the bottom', async ({ page }) => {
  await startRun(page, '持续滚动测试');
  const viewport = page.locator('.conversation');
  const latest = page.getByRole('button', { name: '回到最新消息' });
  await expect(page.locator('.markdown')).toContainText('第 45 段');
  await expect.poll(() => distanceToBottom(viewport)).toBeLessThanOrEqual(2);

  // 即使只离开底部几十像素，也应尊重用户的向上滚动。
  await viewport.hover();
  await page.mouse.wheel(0, -40);
  await expect(latest).toBeVisible();
  await expect.poll(() => distanceToBottom(viewport)).toBeGreaterThan(20);
  const readingTop = await viewport.evaluate((element) => element.scrollTop);
  await advance(page, '持续滚动测试', { content: '\n\n新增段落 A。\n\n新增段落 B。' });
  await expect(page.locator('.markdown')).toContainText('新增段落 B');
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(readingTop);
  await expect(latest).toBeVisible();

  await page.mouse.wheel(0, 10000);
  await expect(latest).toHaveCount(0);
  await advance(page, '持续滚动测试', { content: '\n\n手动回到底部后继续输出。\n\n继续跟随新段落。' });
  await expect(page.locator('.markdown')).toContainText('继续跟随新段落');
  await expect.poll(() => distanceToBottom(viewport)).toBeLessThanOrEqual(2);

  await viewport.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await advance(page, '持续滚动测试', { content: '\n\n键盘上翻时保持阅读位置。' });
  await expect(page.locator('.markdown')).toContainText('键盘上翻时保持阅读位置');
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await latest.click();
  await expect.poll(() => distanceToBottom(viewport)).toBeLessThanOrEqual(2);
  await advance(page, '持续滚动测试', { content: '\n\n点击最新后继续跟随。' });
  await expect(page.locator('.markdown')).toContainText('点击最新后继续跟随');
  await expect.poll(() => distanceToBottom(viewport)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
});

test('shows the latest reasoning in one collapsed line and preserves the complete expanded text', async ({ page }) => {
  await startRun(page, '思考预览测试');
  const preview = page.locator('.reasoning-preview');
  const complete = page.locator('.reasoning-content');
  await expect(preview).toContainText('当前思考末尾');
  const rowHeight = await page.locator('.reasoning-step > summary').evaluate((element) => element.clientHeight);
  await advance(page, '思考预览测试', { reasoning_content: '\n最新判断：检查工具结果。' });
  await expect(preview).toContainText('最新判断：检查工具结果。');
  await expect(preview).not.toContainText('思考起点');
  expect(await page.locator('.reasoning-step > summary').evaluate((element) => element.clientHeight)).toBe(rowHeight);
  // 文本末尾在可见区域内，避免 DOM 更新了但画面仍只展示开头。
  expect(
    await preview.evaluate((element) => {
      const text = element.firstElementChild!;
      const range = document.createRange();
      range.setStart(text.firstChild!, text.textContent!.length - 10);
      range.setEnd(text.firstChild!, text.textContent!.length);
      const tail = range.getBoundingClientRect();
      const visible = element.getBoundingClientRect();
      return tail.left >= visible.left && tail.right <= visible.right + 1;
    }),
  ).toBe(true);
  await page.locator('.reasoning-step > summary').click();
  await expect(complete).toBeVisible();
  await expect(complete).toContainText('思考起点');
  await expect(complete).toContainText('最新判断：检查工具结果。');
  await advance(page, '思考预览测试', { reasoning_content: '\n展开时继续更新完整内容。' });
  await expect(complete).toContainText('展开时继续更新完整内容');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
});

test('lets readers pause live tool logs independently and return to the latest output', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '运行权限' }).click();
  await page.getByRole('button', { name: '完全权限', exact: false }).click();
  await page.getByRole('button', { name: '确认开启完全权限' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('持续命令输出');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.tool-step > summary')).toContainText("node -e 'for(let i=0;i<60;i++)");
  await page.locator('.tool-step > summary').click();
  const log = page.getByLabel('run_command 实时输出', { exact: true });
  await expect(log).toContainText('历史日志 0');
  await expect(page.locator('.tool-command-bar code')).toContainText('setInterval');
  await expect(page.locator('.tool-inspector')).toHaveCount(0);
  await expect.poll(() => distanceToBottom(log)).toBeLessThanOrEqual(2);
  await log.hover();
  await page.mouse.wheel(0, -40);
  const latest = page.getByRole('button', { name: '最新输出', exact: true });
  await expect(latest).toBeVisible();
  await expect.poll(() => distanceToBottom(log)).toBeGreaterThan(20);
  const top = await log.evaluate((element) => element.scrollTop);
  const length = (await log.innerText()).length;
  await expect.poll(async () => (await log.innerText()).length).toBeGreaterThan(length + 100);
  expect(await log.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(page.locator('.tool-step > summary')).toContainText("node -e 'for(let i=0;i<60;i++)");
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect.poll(() => distanceToBottom(log)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.locator('.tool-step')).toHaveClass(/cancelled/);
});
