import { z } from 'zod';

export const capabilityNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
export const capabilityVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const skillFileSchema = z
  .object({
    /** 相对 Skill 根目录的 POSIX 路径。 */
    path: z.string().min(1).max(500),
    /** 原始文件字节，使用 Base64 保留二进制资源。 */
    content: z.string().max(14_000_000),
  })
  .strict();
export const skillInputSchema = z
  .object({
    name: capabilityNameSchema,
    markdown: z.string().min(1).max(128_000),
    files: skillFileSchema.array().max(200).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();
export const skillUpdateSchema = skillInputSchema.extend({
  /** 省略时保留已有资源，空数组表示清除。 */
  files: skillFileSchema.array().max(200).optional(),
  version: z.number().int().positive(),
});
export const skillSchema = skillInputSchema.extend({
  description: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const skillSummarySchema = skillSchema.omit({ markdown: true, files: true }).extend({ fileCount: z.number() });
export const skillImportSchema = z
  .object({
    filename: z.string().min(1).max(200),
    content: z.string().min(1).max(28_000_000),
  })
  .strict();
export const skillExportSchema = z.object({ filename: z.string(), content: z.string() });
export type SkillInput = z.infer<typeof skillInputSchema>;
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;

const stringMap = z
  .record(z.string().min(1).max(200), z.string().max(8192))
  .refine((value) => Object.keys(value).length <= 50);
export const mcpInputSchema = z
  .object({
    name: capabilityNameSchema,
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().trim().max(4096).default(''),
    args: z.array(z.string().max(4096)).max(100).default([]),
    cwd: z.string().trim().max(4096).default(''),
    url: z.string().trim().max(4096).default(''),
    /** 省略时保留已保存的值，空对象表示清除。读取接口只返回键名。 */
    env: stringMap.optional(),
    headers: stringMap.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const mcpUpdateSchema = mcpInputSchema.extend({ version: z.number().int().positive() });
export const mcpServerSchema = mcpInputSchema.omit({ env: true, headers: true }).extend({
  envKeys: z.string().array(),
  headerKeys: z.string().array(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export const mcpToolListSchema = z.object({ server: z.string(), tools: mcpToolSchema.array() });
export type McpInput = z.infer<typeof mcpInputSchema>;
export type McpUpdate = z.infer<typeof mcpUpdateSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export type StoredMcpServer = McpInput & { version: number; createdAt: string; updatedAt: string };

export const capabilityToolSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('list_skills'), input: z.object({}).strict() }),
  z.object({
    name: z.literal('read_skill'),
    input: z.object({ name: capabilityNameSchema, path: z.string().max(500).optional() }).strict(),
  }),
  z.object({ name: z.literal('get_skill'), input: z.object({ name: capabilityNameSchema }).strict() }),
  z.object({ name: z.literal('create_skill'), input: skillInputSchema }),
  z.object({ name: z.literal('update_skill'), input: skillUpdateSchema }),
  z.object({ name: z.literal('delete_skill'), input: capabilityVersionSchema.extend({ name: capabilityNameSchema }) }),
  z.object({ name: z.literal('import_skill'), input: skillImportSchema }),
  z.object({ name: z.literal('export_skill'), input: z.object({ name: capabilityNameSchema }).strict() }),
  z.object({ name: z.literal('list_mcp_servers'), input: z.object({}).strict() }),
  z.object({ name: z.literal('create_mcp_server'), input: mcpInputSchema }),
  z.object({ name: z.literal('update_mcp_server'), input: mcpUpdateSchema }),
  z.object({
    name: z.literal('delete_mcp_server'),
    input: capabilityVersionSchema.extend({ name: capabilityNameSchema }),
  }),
  z.object({ name: z.literal('list_mcp_tools'), input: z.object({ name: capabilityNameSchema }).strict() }),
  z.object({
    name: z.literal('call_mcp_tool'),
    input: z
      .object({
        name: capabilityNameSchema,
        tool: z.string().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()),
      })
      .strict(),
  }),
]);
export type CapabilityToolCall = z.infer<typeof capabilityToolSchema>;
