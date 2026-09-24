import { randomBytes } from 'node:crypto';
import {
  createRunSchema,
  saveModelSettingsSchema,
  createWorkspaceSchema,
  createThreadSchema,
  updatePermissionSchema,
  approvalDecisionSchema,
  feedbackInputSchema,
  renameWorkspaceSchema,
  createSteeringSchema,
  renameThreadSchema,
} from '@flux-agent/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { Logger } from 'pino';
import type { RunManager } from '../runs/run-manager.js';
import { ApplicationError } from './application-error.js';
import { localAccess, SESSION_COOKIE } from './local-access.js';
import { streamRunEvents } from './run-events.js';
import type { ModelSettingsService } from '../settings/model-settings-service.js';
import { memoryRoutes } from './memory-routes.js';
import { DirectoryPicker } from '../workspaces/directory-picker.js';

interface ApplicationOptions {
  manager: RunManager;
  logger: Logger;
  origins: string[];
  settings: ModelSettingsService;
  directoryPicker?: Pick<DirectoryPicker, 'choose'>;
}

export function createApp({
  manager,
  logger,
  origins,
  settings,
  directoryPicker = new DirectoryPicker(),
}: ApplicationOptions): Hono {
  const app = new Hono();
  const token = randomBytes(32).toString('hex');
  app.use('/api/*', localAccess(token, origins));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 256_000,
      onError: () => {
        throw new ApplicationError('BODY_TOO_LARGE', '请求内容过大。', 413);
      },
    }),
  );
  app.get('/api/session', (context) => {
    setCookie(context, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/api' });
    const { model, configured } = settings.getSettings();
    return context.json({ token, model: model || null, configured, storage: manager.storage });
  });
  app.get('/api/settings/model', (context) => context.json(settings.getSettings()));
  app.post('/api/settings/model', async (context) => {
    const body: unknown = await context.req.json().catch(() => {
      throw new ApplicationError('INVALID_JSON', '请求必须是 JSON。');
    });
    const result = saveModelSettingsSchema.safeParse(body);
    if (!result.success)
      throw new ApplicationError(
        'INVALID_MODEL_SETTINGS',
        '请填写有效的接口地址和模型名称，API Key 不得超过 8192 个字符。',
      );
    return context.json(await settings.save(result.data));
  });
  app.get('/api/threads', (context) => context.json(manager.listThreads()));
  app.get('/api/workspaces', (context) => context.json(manager.workspaces.list()));
  app.post('/api/workspaces/choose', async (context) => {
    const path = await directoryPicker.choose(context.req.raw.signal);
    return context.json({ workspace: path === null ? null : manager.workspaces.create(path) });
  });
  app.post('/api/workspaces', async (context) => {
    const result = createWorkspaceSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_WORKSPACE', '请输入有效的工作区目录。');
    return context.json(manager.workspaces.create(result.data.rootPath), 201);
  });
  app.post('/api/workspaces/:id/rename', async (context) => {
    const result = renameWorkspaceSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_WORKSPACE_NAME', '工作区名称需为 1 至 100 个字符。');
    return context.json(manager.workspaces.rename(context.req.param('id'), result.data.name));
  });
  app.post('/api/workspaces/:id/archive', (context) =>
    context.json(manager.workspaces.archive(context.req.param('id'))),
  );
  app.post('/api/threads', async (context) => {
    const body = await context.req.text();
    let value: unknown = {};
    try {
      if (body) value = JSON.parse(body);
    } catch {
      throw new ApplicationError('INVALID_JSON', '请求必须是 JSON。');
    }
    const result = createThreadSchema.safeParse(value);
    if (!result.success) throw new ApplicationError('INVALID_THREAD', '请选择有效的工作区。');
    return context.json(manager.createThread(result.data.workspaceId), 201);
  });
  app.post('/api/threads/:id/permission', async (context) => {
    const result = updatePermissionSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_PERMISSION', '权限参数不正确。');
    return context.json(
      manager.setPermission(context.req.param('id'), result.data.mode, result.data.confirmFullAccess),
    );
  });
  app.post('/api/runs/:id/approvals/:approvalId', async (context) => {
    const result = approvalDecisionSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_APPROVAL', '请选择允许或拒绝。');
    manager.approvals.decide(context.req.param('id'), context.req.param('approvalId'), result.data.decision);
    return context.json(manager.getRun(context.req.param('id')));
  });
  app.get('/api/threads/:id', (context) => context.json(manager.getThread(context.req.param('id'))));
  app.get('/api/threads/:id/file', (context) => {
    const path = context.req.query('path');
    if (!path || path.length > 4096 || path.includes('\0'))
      throw new ApplicationError('INVALID_PATH', '请选择有效的文件路径。');
    return context.json(manager.previewFile(context.req.param('id'), path));
  });
  app.post('/api/threads/:id/rename', async (context) => {
    const result = renameThreadSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_TITLE', '会话名称须为 1 至 100 个字符。');
    return context.json(manager.renameThread(context.req.param('id'), result.data.title));
  });
  app.post('/api/threads/:id/delete', (context) => {
    manager.deleteThread(context.req.param('id'));
    return context.json({ deleted: true });
  });
  app.post('/api/threads/:id/runs', async (context) => {
    const body: unknown = await context.req.json().catch(() => {
      throw new ApplicationError('INVALID_JSON', '请求必须是 JSON。');
    });
    const result = createRunSchema.safeParse(body);
    if (!result.success) throw new ApplicationError('INVALID_MESSAGE', '请输入 1 至 32000 个字符的消息。');
    return context.json(manager.startRun(context.req.param('id'), result.data.content), 201);
  });
  app.get('/api/runs/:id', (context) => context.json(manager.getRun(context.req.param('id'))));
  app.post('/api/runs/:id/feedback', async (context) => {
    const result = feedbackInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_FEEDBACK', '请提交有效的评价，文字意见最多 2000 字。');
    return context.json(manager.saveFeedback(context.req.param('id'), result.data));
  });
  app.post('/api/runs/:id/cancel', (context) => context.json(manager.cancelRun(context.req.param('id'))));
  app.post('/api/runs/:id/steer', async (context) => {
    const result = createSteeringSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_STEERING', '请输入 1 至 32000 个字符的补充消息。');
    return context.json(manager.steerRun(context.req.param('id'), result.data));
  });
  app.get('/api/runs/:id/events', (context) => {
    const runId = context.req.param('id');
    manager.getRun(runId);
    return streamSSE(context, (stream) => streamRunEvents(stream, manager, runId));
  });
  app.route('/api', memoryRoutes(manager));
  app.all('/api/*', (context) => context.json({ code: 'NOT_FOUND', message: '接口不存在。' }, 404));
  app.onError((error, context) => {
    if (error instanceof ApplicationError)
      return context.json({ code: error.code, message: error.message }, error.status);
    logger.error({ method: context.req.method, path: context.req.path }, 'Unhandled API error');
    return context.json({ code: 'INTERNAL_ERROR', message: '服务暂时不可用。' }, 500);
  });
  return app;
}
