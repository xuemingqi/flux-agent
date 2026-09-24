import { Hono } from 'hono';
import { memoryInputSchema, memoryUpdateSchema, memoryVersionSchema } from '@flux-agent/contracts';
import type { RunManager } from '../runs/run-manager.js';
import { ApplicationError } from './application-error.js';

export function memoryRoutes(manager: RunManager): Hono {
  const app = new Hono();
  app.use('/workspaces/:workspaceId/memories*', async (context, next) => {
    manager.workspaces.require(context.req.param('workspaceId')!);
    await next();
  });
  app.get('/workspaces/:workspaceId/memories', (context) =>
    context.json(manager.memory.list(context.req.param('workspaceId'), context.req.query('q'))),
  );
  app.post('/workspaces/:workspaceId/memories', async (context) => {
    const result = memoryInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success)
      throw new ApplicationError('INVALID_MEMORY', '请输入 1 至 4000 个字符的记忆和有效的过期时间。');
    return context.json(manager.memory.create(context.req.param('workspaceId'), result.data), 201);
  });
  app.post('/workspaces/:workspaceId/memories/:id', async (context) => {
    const result = memoryUpdateSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_MEMORY', '记忆内容、状态或版本无效，请刷新后重试。');
    return context.json(manager.memory.update(context.req.param('workspaceId'), context.req.param('id'), result.data));
  });
  app.post('/workspaces/:workspaceId/memories/:id/delete', async (context) => {
    const result = memoryVersionSchema.safeParse(await context.req.json().catch(() => null));
    if (!result.success) throw new ApplicationError('INVALID_MEMORY', '删除请求缺少记忆版本，请刷新后重试。');
    manager.memory.delete(context.req.param('workspaceId'), context.req.param('id'), result.data.version);
    return context.json({ deleted: true });
  });
  return app;
}
