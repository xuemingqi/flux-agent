import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  mcpInputSchema,
  mcpToolSchema,
  type McpInput,
  type McpUpdate,
  type StoredMcpServer,
} from '@flux-agent/contracts';
import type { CapabilityStore } from '../storage/capability-store.js';
import { ApplicationError } from '../api/application-error.js';

const MCP_TIMEOUT_MS = 30_000;
const MAX_MCP_TOOLS = 200;

export function publicMcp(server: StoredMcpServer) {
  const { env, headers, ...entry } = server;
  return { ...entry, envKeys: Object.keys(env ?? {}), headerKeys: Object.keys(headers ?? {}) };
}

/** MCP 基础能力只维护配置和协议连接，不负责页面或 Agent 的授权策略。 */
export class McpService {
  constructor(private readonly store: CapabilityStore) {}

  list() {
    return this.store.mcps().map(publicMcp);
  }

  get(name: string): StoredMcpServer {
    const server = this.store.mcps().find((entry) => entry.name === name);
    if (!server) throw new ApplicationError('MCP_NOT_FOUND', 'MCP 服务不存在。', 404);
    return server;
  }

  create(input: McpInput): StoredMcpServer {
    const data = this.validate(input);
    if (this.list().some((server) => server.name === data.name))
      throw new ApplicationError('MCP_EXISTS', '同名 MCP 已存在，请编辑现有配置。', 409);
    const now = new Date().toISOString();
    const server = { ...data, version: 1, createdAt: now, updatedAt: now };
    this.store.saveMcp(server);
    return server;
  }

  update(name: string, input: McpUpdate): StoredMcpServer {
    const previous = this.get(name);
    this.checkVersion(previous, input.version);
    if (input.name !== name) throw new ApplicationError('MCP_NAME_CHANGED', '修改配置时请保留 MCP 名称。');
    const { version: _version, ...data } = input;
    const server = {
      ...previous,
      ...this.validate(data),
      env: data.env ?? previous.env,
      headers: data.headers ?? previous.headers,
      version: previous.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveMcp(server);
    return server;
  }

  delete(name: string, version: number): void {
    this.checkVersion(this.get(name), version);
    this.store.deleteMcp(name);
  }

  async listTools(name: string, signal: AbortSignal, expectedVersion?: number) {
    return this.connected(name, signal, expectedVersion, async (client) => {
      const tools = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: MCP_TIMEOUT_MS });
        tools.push(...page.tools.map((tool) => mcpToolSchema.parse(tool)));
        if (tools.length > MAX_MCP_TOOLS) throw new ApplicationError('MCP_TOOL_LIMIT', 'MCP 工具数量超过 200。');
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new ApplicationError('MCP_PAGINATION', 'MCP 返回了重复的分页游标。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { server: name, tools };
    });
  }

  async callTool(
    name: string,
    tool: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
    expectedVersion?: number,
  ) {
    return this.connected(name, signal, expectedVersion, async (client) => {
      const result = await client.callTool({ name: tool, arguments: arguments_ }, undefined, {
        signal,
        timeout: MCP_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 300_000,
      });
      return { content: JSON.stringify(result), failed: result.isError === true };
    });
  }

  /** 每次操作拥有独立连接，取消、失败和正常结束都会关闭连接及本地进程。 */
  private async connected<T>(
    name: string,
    signal: AbortSignal,
    expectedVersion: number | undefined,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const server = this.get(name);
    if (expectedVersion !== undefined) this.checkVersion(server, expectedVersion);
    if (!server.enabled) throw new ApplicationError('MCP_DISABLED', '此 MCP 已禁用。', 403);
    const client = new Client({ name: 'flux-agent', version: '1.0.0' });
    const transport =
      server.transport === 'stdio'
        ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            cwd: server.cwd || undefined,
            env: { ...getDefaultEnvironment(), ...server.env },
            stderr: 'ignore',
          })
        : server.transport === 'sse'
          ? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
          : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    const connectionSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_TIMEOUT_MS)]);
    const close = () => {
      void client.close().catch(() => {});
      void transport.close().catch(() => {});
    };
    connectionSignal.addEventListener('abort', close, { once: true });
    let abortConnection: (() => void) | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_resolve, reject) => {
          abortConnection = () => reject(connectionSignal.reason);
          connectionSignal.addEventListener('abort', abortConnection, { once: true });
          if (connectionSignal.aborted) abortConnection();
        }),
      ]);
      connectionSignal.throwIfAborted();
      connectionSignal.removeEventListener('abort', close);
      if (abortConnection) connectionSignal.removeEventListener('abort', abortConnection);
      signal.addEventListener('abort', close, { once: true });
      // 配置在连接期间被禁用或修改时，不能继续使用旧配置执行。
      const current = this.get(name);
      this.checkVersion(current, server.version);
      if (!current.enabled) throw new ApplicationError('MCP_DISABLED', '此 MCP 已禁用。', 403);
      signal.throwIfAborted();
      return await action(client);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('MCP_CONNECTION_FAILED', 'MCP 连接或调用失败，请检查配置、凭据和服务状态。', 503);
    } finally {
      connectionSignal.removeEventListener('abort', close);
      if (abortConnection) connectionSignal.removeEventListener('abort', abortConnection);
      signal.removeEventListener('abort', close);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  /** 连接字段在基础层统一校验，两个管理入口不能保存不可用的配置形状。 */
  private validate(input: McpInput): McpInput {
    const result = mcpInputSchema.safeParse(input);
    if (!result.success) throw new ApplicationError('INVALID_MCP', 'MCP 参数格式不正确。');
    const data = result.data;
    if (data.transport === 'stdio') {
      if (!data.command || data.command.includes('\0') || data.args.some((arg) => arg.includes('\0')))
        throw new ApplicationError('INVALID_MCP', '本地 MCP 需填写可执行命令及有效参数。');
      if (data.cwd && (!isAbsolute(data.cwd) || !this.isDirectory(data.cwd)))
        throw new ApplicationError('INVALID_MCP', '工作目录需为存在的绝对目录。');
    } else {
      try {
        const url = new URL(data.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
          throw new Error('Invalid URL');
        new Headers(data.headers);
      } catch {
        throw new ApplicationError('INVALID_MCP', '远程 MCP 需填写 HTTP(S) 地址；凭据请放在请求头。');
      }
    }
    return data;
  }

  /** 文件系统检查只用于用户明确配置的工作目录。 */
  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  /** 防止旧编辑或审批覆盖并发修改。 */
  private checkVersion(server: StoredMcpServer, version: number): void {
    if (server.version !== version)
      throw new ApplicationError('CAPABILITY_CONFLICT', 'MCP 配置已变化，请刷新后重试。', 409);
  }
}
