import { Hono } from 'hono';
import type { z } from 'zod';
import {
  skillInputSchema,
  skillUpdateSchema,
  skillImportSchema,
  capabilityVersionSchema,
  mcpInputSchema,
  mcpUpdateSchema,
} from '@flux-agent/contracts';
import type { CapabilityPageService } from '../settings/capability-page-service.js';
import { ApplicationError } from './application-error.js';

async function input<T>(value: Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await value.catch(() => null));
  if (!parsed.success) throw new ApplicationError('INVALID_CAPABILITY', '参数格式不正确，请检查内容与版本。');
  return parsed.data;
}

export function capabilityRoutes(service: CapabilityPageService): Hono {
  const app = new Hono();
  app.get('/skills', (context) => context.json(service.listSkills()));
  app.post('/skills/import', async (context) => {
    const data = await input(context.req.json(), skillImportSchema);
    return context.json(service.importSkill(data.filename, data.content), 201);
  });
  app.get('/skills/:name/export', (context) => context.json(service.exportSkill(context.req.param('name'))));
  app.get('/skills/:name', (context) => context.json(service.getSkill(context.req.param('name'))));
  app.post('/skills', async (context) =>
    context.json(service.createSkill(await input(context.req.json(), skillInputSchema)), 201),
  );
  app.post('/skills/:name/delete', async (context) => {
    const data = await input(context.req.json(), capabilityVersionSchema);
    return context.json(service.deleteSkill(context.req.param('name'), data.version));
  });
  app.post('/skills/:name', async (context) =>
    context.json(service.updateSkill(context.req.param('name'), await input(context.req.json(), skillUpdateSchema))),
  );
  app.get('/mcps', (context) => context.json(service.listMcps()));
  app.post('/mcps', async (context) =>
    context.json(service.createMcp(await input(context.req.json(), mcpInputSchema)), 201),
  );
  app.post('/mcps/:name/test', async (context) =>
    context.json(await service.testMcp(context.req.param('name'), context.req.raw.signal)),
  );
  app.post('/mcps/:name/delete', async (context) => {
    const data = await input(context.req.json(), capabilityVersionSchema);
    return context.json(service.deleteMcp(context.req.param('name'), data.version));
  });
  app.post('/mcps/:name', async (context) =>
    context.json(service.updateMcp(context.req.param('name'), await input(context.req.json(), mcpUpdateSchema))),
  );
  return app;
}
