import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelEndpointSchema } from '@flux-agent/contracts';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  FLUX_DATA_DIR: z.string().trim().min(1).default(join(homedir(), '.flux-agent')),
  FLUX_WORKSPACE_DIR: z
    .string()
    .trim()
    .min(1)
    .default(fileURLToPath(new URL('../../../..', import.meta.url))),
  MODEL_BASE_URL: modelEndpointSchema.default('https://api.openai.com/v1'),
  MODEL_API_KEY: z.string().trim().default(''),
  MODEL_NAME: z.string().trim().default(''),
  MODEL_STREAM_USAGE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export function loadConfiguration(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`环境变量格式错误：${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return result.data;
}
