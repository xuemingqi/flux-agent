import { expect, test } from '@playwright/test';

test('switches between the original views and live agents without starting another run', async ({
  page,
  request,
}, testInfo) => {
  let startedRuns = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/threads\/[^/]+\/runs$/.test(request.url())) startedRuns++;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('多 Agent 测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '子 Agent 任务' })).toContainText('1/2 已完成');
  try {
    await page.getByRole('tab', { name: '协作空间' }).click();
    const scene = page.getByRole('group', { name: 'Agent 协作场景' });
    await expect(page.locator('.animal-workroom')).toHaveAttribute('data-renderer', 'webgl');
    await expect(scene.getByRole('button')).toHaveCount(3);
    await expect(scene.getByRole('button', { name: '查看 分析 B 的过程' })).toContainText('正在思考');
    await scene.getByRole('button', { name: '查看 分析 B 的过程' }).click();
    const insight = page.getByRole('region', { name: 'Agent 信息详情' });
    await expect(insight).toContainText('子任务读取 B的思考');
    await expect(insight).toContainText('正在整理子任务结果');
    await expect(insight.locator('.history-tool')).toHaveCount(1);
    await expect(page.getByRole('region', { name: '分析 B 的执行过程' })).toContainText('正在整理子任务结果');
    await scene.getByRole('button', { name: '查看 分析 A 的过程' }).click();
    await page.getByRole('region', { name: '分析 A 的执行过程' }).locator('[data-tool="read_file"]').click();
    await expect(page.locator('.tool-inspector .file-code')).not.toBeEmpty();
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();

    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await expect(page.getByRole('region', { name: '子 Agent 任务' })).toContainText('1/2 已完成');
    await page.getByRole('tab', { name: /轨迹/ }).click();
    await expect(page.locator('.trace-run')).toBeVisible();
    await page.getByRole('tab', { name: '协作空间' }).click();
    await page.reload();
    await expect(page.getByRole('tab', { name: '协作空间' })).toHaveAttribute('aria-selected', 'true');
    await expect(scene.getByRole('button', { name: '查看 分析 B 的过程' })).toContainText('正在思考');
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '协作空间', exact: true })).toBeInViewport();
    expect(startedRuns).toBe(1);
    await request.post('http://127.0.0.1:4319/release-subagents');
    await expect(scene.getByRole('button', { name: '查看 主 Agent 的过程' })).toContainText('主 Agent 已汇总');
    await expect(scene.locator('[data-activity="done"]')).toHaveCount(3);
    await expect(page.getByRole('heading', { name: '协作空间', exact: true })).toBeInViewport();
    await scene.getByRole('button', { name: '查看 分析 B 的过程' }).click();
    await expect(insight).toContainText('子任务读取 B的思考');
    await expect(insight).toContainText('正在整理子任务结果');
    await expect(insight).toContainText('子任务读取 B完成');
    await insight.getByRole('button', { name: '收起详情' }).click();
    await page.screenshot({ path: testInfo.outputPath('agent-world.png') });
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await expect(page.locator('.assistant-run > .run-steps .markdown').last()).toContainText('主 Agent 已汇总');
    expect(startedRuns).toBe(1);
  } finally {
    await request.post('http://127.0.0.1:4319/release-subagents');
  }
});

test('keeps pending approvals actionable while viewing an earlier turn in the agent world', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('查询当前时间');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('查询完成');
  await page.getByRole('tab', { name: '协作空间' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('拒绝测试修改');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toContainText('等待审批');
  await page.getByLabel('展示轮次').selectOption({ index: 0 });
  await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toContainText('查询完成');
  const approval = page.getByRole('region', { name: '文件修改审批' });
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: '查看修改前后内容' }).click();
  await expect(page.locator('.file-change-comparison')).toContainText('must not exist');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await approval.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(approval).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.getByLabel('展示轮次').selectOption({ index: 1 });
  await expect(page.getByRole('region', { name: '主 Agent 的执行过程' })).toContainText('APPROVAL_DENIED');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page.locator('.assistant-run')).toHaveCount(2);
});

test('supports an empty world, live reasoning and cancellation on a narrow screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('tab', { name: '协作空间' }).click();
  await expect(page.getByText('等待第一个任务')).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill('慢速思考');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const scene = page.getByRole('group', { name: 'Agent 协作场景' });
  await expect(scene.getByRole('button')).toHaveCount(1);
  await expect(page.locator('.animal-workroom')).toHaveAttribute('data-renderer', 'webgl');
  await expect(scene).toContainText('模型返回的思考');
  await expect(page.locator('.world-agent-detail .reasoning-content')).toContainText('先梳理问题');
  await page.reload();
  await expect(scene).toContainText('正在思考');
  await expect(page.getByRole('heading', { name: '协作空间', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(scene.getByRole('button')).toContainText('已停止');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agent-world-mobile.png') });
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
});

test('delivers real sibling messages, animates a meeting and preserves the exchange after reload', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('tab', { name: '协作空间' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('协作交流测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  try {
    const room = page.locator('.animal-workroom');
    const record = page.getByRole('region', { name: 'Agent 交流记录' });
    await expect(room).toHaveAttribute('data-renderer', 'webgl');
    await expect(record.locator('li')).toHaveCount(2);
    await expect(record.getByText('已送达', { exact: true })).toHaveCount(2);
    await expect(record).toContainText('空输入应返回明确提示');
    await expect(record.locator('.markdown')).toHaveCount(2);
    await page.getByRole('button', { name: '查看 实现伙伴 的过程' }).click();
    const insight = page.getByRole('region', { name: 'Agent 信息详情' });
    await expect(insight).toContainText('发送给 审查伙伴');
    await expect(insight).toContainText('来自 审查伙伴');
    await insight.getByRole('button', { name: '收起详情' }).click();
    await record.getByRole('button', { name: '回放这次交流' }).first().click();
    await expect(room).toHaveAttribute('data-encounter-phase', 'talking');
    await expect(page.getByLabel('当前 Agent 交流')).toContainText('实现伙伴');
    await expect(page.getByLabel('当前 Agent 交流')).toContainText('审查伙伴');
    await expect(page.getByLabel('当前 Agent 交流')).toContainText('请帮忙复核空输入');
    await page.getByRole('button', { name: '暂停动画', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('animal-agent-meeting.png') });
    await page.reload();
    await expect(record.locator('li')).toHaveCount(2);
    await expect(page.getByLabel('当前 Agent 交流')).toHaveCount(0);
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await expect(record).toContainText('我把检查结果发给你');
    await request.post('http://127.0.0.1:4319/release-subagents');
    await expect(page.locator('.assistant-run > .run-steps .markdown').last()).toContainText('主 Agent 已汇总复核结果');
    expect(errors).toEqual([]);
  } finally {
    await request.post('http://127.0.0.1:4319/release-subagents');
  }
});

test('keeps task controls and animal labels available when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type.startsWith('webgl')) return null;
      return getContext.apply(this, [type, ...args] as Parameters<typeof getContext>);
    } as typeof getContext;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('tab', { name: '协作空间' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('慢速思考');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.animal-workroom')).toHaveAttribute('data-renderer', 'fallback');
  await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toBeVisible();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toContainText('已停止');
});

test('keeps all rounds and streamed messages in Markdown details after reload', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('查询当前时间');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('查询完成');
  await page.getByRole('tab', { name: '协作空间' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('思考预览测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toContainText('正在思考');
  await page.getByRole('button', { name: '查看 主 Agent 的过程' }).click();
  const insight = page.getByRole('region', { name: 'Agent 信息详情' });
  const details = insight.locator('.insight-content');
  const advance = async (delta: Record<string, string>) => {
    const response = await request.post('http://127.0.0.1:4319/advance-display', {
      data: { question: '思考预览测试', delta },
    });
    expect(response.ok()).toBe(true);
  };
  try {
    await expect(details).toContainText('第 1 轮');
    await expect(details).toContainText('查询完成');
    await expect(details).toContainText('思考起点');
    await advance({
      content:
        '## 第一份结果\n\n- **保留历史**\n- 支持 `Markdown`\n\n```ts\nconst answer = 42;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 历史 | 已保留 |\n\n<script>window.historyXss = true</script>\n',
    });
    await expect(details.getByRole('heading', { name: '第一份结果' })).toHaveCount(1);
    await expect(details.locator('strong')).toContainText('保留历史');
    await expect(details.locator('pre code').last()).toContainText('const answer = 42;');
    await expect(details.getByRole('table')).toContainText('已保留');
    await advance({ reasoning_content: '\n\n### 第二次分析\n\n检查**上一条结果**。' });
    await advance({ content: '\n\n## 最终结果\n\n旧消息应当继续保留。' });
    await expect(details.getByRole('heading', { name: '最终结果' })).toHaveCount(1);
    await expect(details.getByRole('heading', { name: '第一份结果' })).toHaveCount(1);
    await expect(details.getByRole('heading', { name: '第二次分析' })).toHaveCount(1);
    await page.reload();
    await page.getByRole('button', { name: '查看 主 Agent 的过程' }).click();
    await expect(details.getByRole('heading', { name: '第一份结果' })).toHaveCount(1);
    await expect(details.getByRole('heading', { name: '最终结果' })).toHaveCount(1);
    await expect(details).toContainText('查询完成');
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).historyXss)).toBeUndefined();
    await details.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.screenshot({ path: testInfo.outputPath('modern-workspace-history.png') });
    await page.keyboard.press('Escape');
    await expect(insight).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看 主 Agent 的过程' })).toBeFocused();
  } finally {
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
  }
});

test('keeps nine agents compact and individually inspectable on desktop and mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('查询当前时间');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.markdown').last()).toContainText('查询完成');
  // 仅扩展展示快照，验证拥挤布局，不向真实模型额外启动任务。
  await page.route(/\/api\/threads\/[^/]+$/, async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    const run = thread.runs[0];
    run.subagents = Array.from({ length: 8 }, (_, index) => ({
      id: `visual-agent-${index}`,
      name: `伙伴 ${index + 1}`,
      task: '检查项目并分享结果',
      status: 'succeeded',
      output: `## 检查结果 ${index + 1}\n\n- 已完成检查\n- **保留所有消息**`,
      steps: [
        { id: 'earlier', kind: 'reasoning', content: '先阅读文档，再检查实现。', createdAt: run.createdAt },
        {
          id: 'latest',
          kind: 'text',
          content: `## 检查结果 ${index + 1}\n\n- 已完成检查\n- **保留所有消息**`,
          createdAt: run.finishedAt,
        },
      ],
      messages: [],
      context: [],
      communications: [],
      compaction: null,
      usage: null,
      error: null,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    }));
    await route.fulfill({ response, json: thread });
  });
  await page.getByRole('tab', { name: '协作空间' }).click();
  await page.reload();
  const room = page.locator('.animal-workroom');
  const actors = room.locator('.world-agent');
  const insight = page.getByRole('region', { name: 'Agent 信息详情' });
  await expect(room).toHaveAttribute('data-renderer', 'webgl');
  await expect(actors).toHaveCount(9);
  await page.getByRole('button', { name: '暂停动画', exact: true }).click();
  const checkLabels = async () => {
    const bounds = await actors.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (let i = 0; i < bounds.length; i++) {
      const a = bounds[i]!;
      for (const b of bounds.slice(i + 1))
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(
          true,
        );
    }
  };
  await checkLabels();
  await page.screenshot({ path: testInfo.outputPath('modern-workspace-nine-agents.png') });
  await actors.last().click();
  await expect(insight).toContainText('先阅读文档');
  await expect(insight.getByRole('heading', { name: '检查结果 8' })).toBeVisible();
  await expect(insight).toHaveCount(1);
  await insight.getByRole('button', { name: '收起详情' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkLabels();
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await actors.last().click();
  await expect(insight.getByRole('heading', { name: '检查结果 8' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('modern-workspace-mobile-details.png') });
  await insight.getByRole('button', { name: '收起详情' }).click();
  await room.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('modern-workspace-mobile-nine-agents.png') });
});
