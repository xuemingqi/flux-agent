import { apiErrorSchema, sessionSchema, type Session } from '@flux-agent/contracts';
import type { z } from 'zod';

let sessionToken = '';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flux-Client': 'web', 'X-Flux-Token': sessionToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(data);
    if (error.success) throw new ApiRequestError(error.data.message, error.data.code);
    throw new Error(`请求失败 (${response.status})`);
  }
  return schema.parse(data);
}

export async function connect(): Promise<Session> {
  const session = await request('/session', sessionSchema);
  sessionToken = session.token;
  return session;
}
