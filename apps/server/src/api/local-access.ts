import { timingSafeEqual } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { ApplicationError } from './application-error.js';

export const SESSION_COOKIE = 'flux_session';

function matchesToken(value: string | undefined, token: string): boolean {
  return (
    value !== undefined &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token))
  );
}

export function localAccess(token: string, origins: string[]) {
  const allowedOrigins = new Set(origins);
  const allowedHosts = new Set(origins.map((origin) => new URL(origin).host));
  return createMiddleware(async (context, next) => {
    const origin = context.req.header('origin');
    if (
      !allowedHosts.has(context.req.header('host') ?? new URL(context.req.url).host) ||
      (origin && !allowedOrigins.has(origin)) ||
      context.req.header('sec-fetch-site') === 'cross-site'
    ) {
      throw new ApplicationError('LOCAL_ACCESS_ONLY', '只允许从本地工作台访问。', 403);
    }
    if (context.req.path === '/api/session' && context.req.method === 'GET') {
      if (context.req.header('x-flux-client') !== 'web')
        throw new ApplicationError('CLIENT_REQUIRED', '请从工作台打开。', 403);
    } else if (
      !matchesToken(getCookie(context, SESSION_COOKIE), token) ||
      (!['GET', 'HEAD'].includes(context.req.method) && !matchesToken(context.req.header('x-flux-token'), token))
    ) {
      throw new ApplicationError('SESSION_EXPIRED', '本地连接已失效，请刷新页面。', 401);
    }
    context.header('Cache-Control', 'no-store');
    await next();
  });
}
