import { expect, test, type Locator } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

async function chooseAction(row: Locator, name: string) {
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await row.getByRole('button', { name, exact: true }).click();
}

test('manages Skill resources, exports/imports ZIP, and loads the skill in an Agent conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await page.getByRole('button', { name: '创建 Skill', exact: true }).click();
  await page.getByLabel('Skill 名称', { exact: true }).fill('browser-skill');
  await page
    .getByLabel('SKILL.md 内容', { exact: true })
    .fill('---\nname: browser-skill\ndescription: 用于浏览器验证\n---\n\nSKILL-ORIGINAL-VERIFIED\n');
  await page
    .locator('.capability-upload input')
    .setInputFiles({ name: 'resource.txt', mimeType: 'text/plain', buffer: Buffer.from('original-resource') });
  await page.getByRole('button', { name: '保存 Skill', exact: true }).click();
  const card = page
    .locator('.capability-card')
    .filter({ has: page.getByRole('heading', { name: 'browser-skill', exact: true }) });
  await expect(card).toContainText('2 个文件');
  await chooseAction(card, '编辑');
  await expect(page.getByLabel('SKILL.md 内容', { exact: true })).toHaveValue(/SKILL-ORIGINAL-VERIFIED/);
  await page
    .getByLabel('SKILL.md 内容', { exact: true })
    .fill('---\nname: browser-skill\ndescription: 编辑后的用途\n---\n\nSKILL-EDIT-VERIFIED\n');
  await page.getByRole('button', { name: '保存 Skill', exact: true }).click();
  await expect(card).toContainText('v2');
  const downloadEvent = page.waitForEvent('download');
  await chooseAction(card, '导出');
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('browser-skill.zip');
  const path = await download.path();
  if (!path) throw new Error('Missing Skill download');
  await chooseAction(card, '删除');
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page
    .getByLabel('导入 Skill 文件', { exact: true })
    .setInputFiles({ name: 'browser-skill.zip', mimeType: 'application/zip', buffer: await readFile(path) });
  await expect(card).toContainText('编辑后的用途');
  await expect(card).toContainText('2 个文件');
  await chooseAction(card, '禁用');
  await expect(card).toContainText('已禁用');
  await page.reload();
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await expect(card).toContainText('已禁用');
  await chooseAction(card, '启用');
  await expect(card).toContainText('已启用');
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/tmp/flux-skills-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Skill 加载验证');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('SKILL-EDIT-VERIFIED');
});

test('creates a Skill through Agent tools only after concrete approval and shows it on the page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Agent 创建 Skill 验证');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const approval = page.getByRole('region', { name: '能力管理审批' });
  await expect(page.locator('.approval-card')).toContainText('create_skill: agent-created-skill');
  await page.getByRole('button', { name: '查看修改前后内容', exact: true }).click();
  await expect(page.locator('.tool-inspector')).toContainText('Agent 创建的技能');
  await expect(page.getByRole('button', { name: '读取当前文件', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '允许本次修改', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('agent-created-skill');
  await expect(approval).toHaveCount(0);
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await expect(page.locator('.capability-card').filter({ hasText: 'agent-created-skill' })).toContainText('已启用');
});

test('creates, tests and invokes a real stdio MCP and supports editing, disabling and deletion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'MCP 管理', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByLabel('MCP 名称', { exact: true }).fill('browser-mcp');
  await page.getByRole('radio', { name: '本地 stdio', exact: true }).check();
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
  await page
    .getByLabel('参数（JSON 数组）', { exact: true })
    .fill(JSON.stringify([fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url))]));
  await page.locator('.capability-advanced > summary').click();
  await page.getByLabel('环境变量（JSON 对象）', { exact: true }).fill('{"FIXTURE_KEY":"fixture-private"}');
  await page.getByRole('button', { name: '保存 MCP', exact: true }).click();
  const card = page.locator('.capability-card').filter({ hasText: 'browser-mcp' });
  await expect(card).not.toContainText('fixture-private');
  await chooseAction(card, '测试连接');
  await expect(page.getByRole('heading', { name: 'browser-mcp · 连接成功', exact: true })).toBeVisible();
  await expect(page.locator('.capability-tool')).toContainText('echo');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await chooseAction(card, '编辑');
  await expect(page.getByLabel('环境变量（JSON 对象）', { exact: true })).toHaveValue('');
  await expect(page.getByRole('dialog')).toContainText('已保存：FIXTURE_KEY');
  await page.getByRole('button', { name: '保存 MCP', exact: true }).click();
  await expect(card).toContainText('v2');
  await chooseAction(card, '编辑');
  await expect(page.getByRole('dialog')).toContainText('已保存：FIXTURE_KEY');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: '/tmp/flux-mcp-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('button', { name: '运行权限', exact: true }).click();
  await page.getByRole('button', { name: '完全权限', exact: false }).click();
  await page.getByRole('button', { name: '确认开启完全权限', exact: true }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('MCP 调用验证');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('MCP-ECHO-VERIFIED');
  await page.getByRole('button', { name: 'MCP 管理', exact: true }).click();
  await chooseAction(card, '禁用');
  await expect(card).toContainText('已禁用');
  await card.getByRole('button', { name: /的更多操作$/ }).click();
  await expect(card.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('searches and filters populated catalogs, dismisses menus and adapts the list to mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '能力管理', exact: true });
  const navigationBox = (await navigation.boundingBox())!;
  expect(navigationBox.x + navigationBox.width).toBeLessThan(280);
  expect(navigationBox.y).toBeLessThan(100);
  await expect(
    page.getByRole('complementary', { name: '工作台侧栏' }).getByRole('button', { name: /长期记忆|模型设置/ }),
  ).toHaveCount(0);
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const settingsBox = (await settings.boundingBox())!;
  expect(settingsBox.x + settingsBox.width).toBeLessThan(280);
  expect(settingsBox.y).toBeGreaterThan(880);
  await settings.click();
  await expect(page.getByRole('button', { name: '长期记忆', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '模型设置', exact: true })).toBeVisible();
  const settingsPopup = (await page.locator('.app-menu:popover-open').boundingBox())!;
  expect(settingsPopup.x + settingsPopup.width).toBeLessThan(280);
  expect(settingsPopup.y + settingsPopup.height).toBeLessThan(settingsBox.y);
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  const session = await page.request.get('/api/session', { headers: { 'x-flux-client': 'web' } });
  const { token } = await session.json();
  const headers = { 'x-flux-token': token };
  const skills = [
    ['code-review', '检查代码变更，关注正确性与可维护性'],
    ['weekly-report', '整理工作记录，生成中文周报'],
    ['data-analysis', '分析数据，提取关键指标与变化趋势'],
    ['release-check', '核对版本与构建结果，完成发布前检查'],
    ['api-design', '设计清晰、一致的接口与数据契约'],
    ['test-planning', '根据需求制定可执行的测试方案'],
  ];
  for (const [name, description] of skills) {
    const response = await page.request.post('/api/skills', {
      headers,
      data: {
        name,
        markdown: `---\nname: ${name}\ndescription: ${description}\n---\n\n# 操作步骤\n`,
        enabled: name !== 'test-planning',
      },
    });
    expect(response.ok()).toBe(true);
  }
  for (const name of ['github', 'postgres', 'browser-tools', 'documents', 'design-assets', 'local-files']) {
    const response = await page.request.post('/api/mcps', {
      headers,
      data:
        name === 'local-files'
          ? { name, transport: 'stdio', command: 'npx', args: ['-y', '@example/local-files'], enabled: false }
          : { name, transport: name === 'documents' ? 'sse' : 'http', url: `https://${name}.example.com/mcp` },
    });
    expect(response.ok()).toBe(true);
  }
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  const catalog = page.getByRole('region', { name: 'Skill 管理', exact: true });
  const search = page.getByRole('searchbox', { name: '搜索技能', exact: true });
  await search.fill('中文周报');
  await expect(catalog.locator('.capability-card')).toHaveCount(1);
  await expect(catalog.getByRole('heading', { name: 'weekly-report', exact: true })).toBeVisible();
  await search.fill('nothing-matches');
  await expect(catalog).toContainText('没有匹配的技能');
  await search.fill('');
  await page
    .getByRole('group', { name: '按启用状态筛选' })
    .getByRole('button', { name: '已禁用', exact: true })
    .click();
  await expect(catalog.locator('.capability-card')).toHaveCount(1);
  await expect(catalog.getByRole('heading', { name: 'test-planning', exact: true })).toBeVisible();
  await page.getByRole('group', { name: '按启用状态筛选' }).getByRole('button', { name: '全部', exact: true }).click();
  const more = page.getByRole('button', { name: 'Skill code-review 的更多操作', exact: true });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(catalog.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await more.click();
  await catalog.getByRole('heading', { name: 'Skill 管理', exact: true }).click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: '/tmp/flux-skills-codex-desktop.png', fullPage: true });
  await settings.click();
  await page.screenshot({ path: '/tmp/flux-settings-modern.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await page.getByRole('button', { name: '创建 Skill', exact: true }).click();
  await page.getByLabel('Skill 名称', { exact: true }).fill('new-workflow');
  await page.screenshot({ path: '/tmp/flux-skill-editor-modern.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: 'MCP 管理', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索 MCP', exact: true }).fill('github.example.com');
  await expect(page.locator('.capability-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索 MCP', exact: true }).fill('');
  await page.screenshot({ path: '/tmp/flux-mcp-codex-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByLabel('MCP 名称', { exact: true }).fill('my-tools');
  await page.getByLabel('服务地址', { exact: true }).fill('https://example.com/mcp');
  await page.screenshot({ path: '/tmp/flux-mcp-editor-modern.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '收起侧栏', exact: true }).first().click();
  await expect(page.getByRole('searchbox', { name: '搜索 MCP', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/flux-mcp-codex-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await page.screenshot({ path: '/tmp/flux-skills-codex-mobile.png', fullPage: true });
});

test('shows Skill and MCP management on a narrow screen without model configuration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4320');
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Skill 管理', exact: true }).last()).toBeVisible();
  await page.screenshot({ path: '/tmp/flux-skills-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: 'MCP 管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加 MCP', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Streamable HTTP', exact: true })).toBeChecked();
  await page.getByLabel('服务地址', { exact: true }).fill('https://example.com/mcp');
  await page.getByRole('radio', { name: '本地 stdio', exact: true }).check();
  await page.getByLabel('启动命令', { exact: true }).fill('node');
  await page.getByRole('radio', { name: 'Streamable HTTP', exact: true }).check();
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue('https://example.com/mcp');
  await expect(page.getByRole('button', { name: '保存 MCP', exact: true })).toBeInViewport();
  await page.screenshot({ path: '/tmp/flux-mcp-editor-modern-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await page.getByRole('button', { name: '创建 Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存 Skill', exact: true })).toBeInViewport();
  await page.screenshot({ path: '/tmp/flux-skill-editor-modern-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
});
