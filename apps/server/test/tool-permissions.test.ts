import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionMode, Run, Workspace } from '@flux-agent/contracts';
import type { ToolRequest, ToolResult } from '@flux-agent/agent-runtime';
import { InMemoryRunStore } from '../src/runs/in-memory-run-store.js';
import { ApprovalService } from '../src/permissions/approval-service.js';
import { ToolExecutionService } from '../src/tools/tool-execution-service.js';
import { runCommand } from '../src/tools/command-runner.js';
import { MemoryService } from '../src/memory/memory-service.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(mode: PermissionMode = 'read-only') {
  const directory = await mkdtemp(join(tmpdir(), 'flux-permissions-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  await mkdir(root);
  const protectedDirectory = join(directory, 'data');
  await mkdir(protectedDirectory);
  await writeFile(join(root, 'hello.txt'), 'before\n');
  const workspace: Workspace = {
    id: 'workspace',
    name: 'test',
    rootPath: root,
    createdAt: new Date().toISOString(),
    archivedAt: null,
  };
  const run: Run = {
    id: 'run',
    threadId: 'thread',
    workspaceId: workspace.id,
    permissionMode: mode,
    approvals: [],
    assistantMessageId: 'message',
    status: 'running',
    output: '',
    steps: [],
    context: [],
    agent: null,
    plan: null,
    feedback: null,
    steering: [],
    createdAt: workspace.createdAt,
    finishedAt: null,
    usage: null,
    error: null,
  };
  const store = new InMemoryRunStore();
  let approvalReady: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    approvalReady = resolve;
  });
  const approvals = new ApprovalService(() => {
    if (run.status === 'waiting_approval') approvalReady();
  });
  const memory = new MemoryService(store.memory);
  const service = new ToolExecutionService(store, approvals, protectedDirectory, memory);
  const context = service.context(run, workspace);
  const controller = new AbortController();
  const execute = (name: string, input: unknown, id = crypto.randomUUID()) =>
    collect(context.execute({ id, name, input }, controller.signal));
  return { directory, root, protectedDirectory, run, store, approvals, pending, context, controller, execute, memory };
}

async function collect(iterator: AsyncGenerator<string, ToolResult>): Promise<ToolResult> {
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  return next.value;
}

describe('Server-enforced permissions', () => {
  it('lets a read-only run recall confirmed memory without changing scope or exposing candidates', async () => {
    const { execute, run, memory, store } = await fixture();
    memory.create(run.workspaceId, { content: '称呼：小林', pinned: false, expiresAt: null });
    memory.create('other-workspace', { content: '其他工作区身份', pinned: true, expiresAt: null });
    memory.propose(run, '未确认的身份');
    const result = await execute('search_memories', { query: '' }, 'memory-search');
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ total: 1, memories: [{ content: '称呼：小林' }] });
    expect(store.getExecution(run.id, 'memory-search')?.status).toBe('succeeded');
    expect((await execute('search_memories', { query: '', workspaceId: 'other-workspace' })).content).toContain(
      'INVALID_TOOL_INPUT',
    );
  });

  it('reads and searches real files but rejects traversal, symlink escapes and writes in read-only mode', async () => {
    const { execute, root, directory } = await fixture();
    await writeFile(join(directory, 'outside.txt'), 'outside');
    await symlink(directory, join(root, 'escape'));
    expect(await execute('read_file', { path: 'hello.txt' })).toEqual({ content: 'before\n', failed: false });
    expect(JSON.parse((await execute('search_files', { path: '.', query: 'before' })).content).matches).toHaveLength(1);
    expect(JSON.parse((await execute('list_directory', { path: '.' })).content).entries).toHaveLength(2);
    for (const path of ['../outside.txt', 'escape/outside.txt', join(directory, 'outside.txt')]) {
      expect((await execute('read_file', { path })).content).toContain('PATH_DENIED');
    }
    expect((await execute('write_file', { path: 'hello.txt', content: 'bad' })).content).toContain('WRITE_DENIED');
    expect((await execute('run_command', { command: 'echo forbidden' })).content).toContain('COMMAND_DENIED');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('before\n');
  });

  it('reads and persists complete text files larger than 64 KB and searches through their final line', async () => {
    const { execute, root, store, run } = await fixture();
    const content = '完整文件内容 abcdefghijklmnopqrstuvwxyz\n'.repeat(30_000) + 'large-file-final-marker';
    expect(Buffer.byteLength(content)).toBeGreaterThan(1_000_000);
    await writeFile(join(root, 'large.txt'), content);

    expect(await execute('read_file', { path: 'large.txt' }, 'large-read')).toEqual({ content, failed: false });
    expect(store.getExecution(run.id, 'large-read')).toMatchObject({ status: 'succeeded', result: content });
    const search = await execute('search_files', { path: '.', query: 'large-file-final-marker' });
    expect(search.failed).toBe(false);
    expect(JSON.parse(search.content)).toEqual({
      matches: [{ path: 'large.txt', line: 30_001, text: 'large-file-final-marker' }],
      truncated: false,
    });
  });

  it('rejects directories, binary files and invalid UTF-8 when reading without a size limit', async () => {
    const { execute, root } = await fixture();
    await writeFile(join(root, 'binary.bin'), Buffer.concat([Buffer.alloc(70_000, 65), Buffer.from([0])]));
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
    for (const path of ['.', 'binary.bin', 'invalid.txt']) {
      expect((await execute('read_file', { path })).failed).toBe(true);
    }
  });

  it.each(['approved', 'denied'] as const)('waits for the specific user decision: %s', async (decision) => {
    const { execute, run, pending, root, approvals, store } = await fixture('workspace-write');
    const task = execute('write_file', { path: 'hello.txt', content: 'after\n' }, 'write-once');
    await pending;
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(run.status).toBe('waiting_approval');
    const approval = run.approvals[0]!;
    expect(approval).toMatchObject({
      toolCallId: 'write-once',
      workspaceId: 'workspace',
      before: 'before\n',
      after: 'after\n',
    });
    expect(() => approvals.decide('another-run', approval.id, 'approved')).toThrow('不属于');
    approvals.decide(run.id, approval.id, decision);
    expect((await task).failed).toBe(decision === 'denied');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe(decision === 'approved' ? 'after\n' : 'before\n');
    expect(() => approvals.decide(run.id, approval.id, 'approved')).toThrow('已处理');
    if (decision === 'approved') {
      expect(store.getExecution(run.id, 'write-once')?.status).toBe('succeeded');
      expect(
        (await execute('write_file', { path: 'hello.txt', content: 'different' }, 'write-once')).content,
      ).toContain('DUPLICATE_TOOL_CALL');
    }
  });

  it('refuses to overwrite a file changed while approval was pending', async () => {
    const { execute, run, pending, root, approvals } = await fixture('workspace-write');
    const task = execute('write_file', { path: 'hello.txt', content: 'agent change' });
    await pending;
    await writeFile(join(root, 'hello.txt'), 'user change');
    approvals.decide(run.id, run.approvals[0]!.id, 'approved');
    expect((await task).content).toContain('FILE_CHANGED');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('user change');
  });

  it('rechecks parent paths after approval and cancels outstanding approvals', async () => {
    const { execute, run, pending, root, directory, approvals } = await fixture('workspace-write');
    await mkdir(join(root, 'nested'));
    const task = execute('write_file', { path: 'nested/new.txt', content: 'must not escape' });
    await pending;
    await rm(join(root, 'nested'), { recursive: true });
    await symlink(directory, join(root, 'nested'));
    approvals.decide(run.id, run.approvals[0]!.id, 'approved');
    expect((await task).content).toContain('PATH_DENIED');
    await expect(readFile(join(directory, 'new.txt'))).rejects.toThrow();
    await unlink(join(root, 'nested'));
  });

  it('does not write after cancellation or duplicate concurrent calls', async () => {
    const { execute, run, pending, root, approvals, controller } = await fixture('workspace-write');
    const task = execute('write_file', { path: 'hello.txt', content: 'bad' }, 'same-id');
    const rejected = expect(task).rejects.toThrow();
    await pending;
    expect((await execute('write_file', { path: 'hello.txt', content: 'bad' }, 'same-id')).content).toContain(
      'DUPLICATE',
    );
    controller.abort();
    await rejected;
    expect(run.approvals[0]!.status).toBe('cancelled');
    expect(() => approvals.decide(run.id, run.approvals[0]!.id, 'approved')).toThrow();
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('before\n');
  });

  it('expires an overdue approval before accepting a late decision', async () => {
    const { execute, run, pending, root, approvals } = await fixture('workspace-write');
    const task = execute('write_file', { path: 'hello.txt', content: 'too late' });
    await pending;
    const approval = run.approvals[0]!;
    approval.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(() => approvals.decide(run.id, approval.id, 'approved')).toThrow('过期');
    expect((await task).failed).toBe(true);
    expect(approval.status).toBe('expired');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('before\n');
  });

  it('allows full-access writes and real commands, without exposing application data through file tools', async () => {
    const { execute, run, directory, root, protectedDirectory } = await fixture('full-access');
    const path = join(directory, 'allowed.txt');
    expect((await execute('write_file', { path, content: 'allowed' })).failed).toBe(false);
    expect(run.approvals).toHaveLength(0);
    const result = await execute('run_command', { command: 'printf shell-result > command.txt; cat command.txt' });
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.content).output).toBe('shell-result');
    expect(await readFile(join(root, 'command.txt'), 'utf8')).toBe('shell-result');
    await writeFile(join(protectedDirectory, 'model-secret'), 'private');
    expect((await execute('read_file', { path: join(protectedDirectory, 'model-secret') })).content).toContain(
      'PROTECTED_PATH',
    );
    expect((await execute('run_command', { command: 'exit 7' })).failed).toBe(true);
  });

  it('stops a running command and its child process on cancellation', async () => {
    const { root } = await fixture('full-access');
    const controller = new AbortController();
    const iterator = runCommand('sleep 60 & echo $!; wait', root, controller.signal);
    const first = await iterator.next();
    const pid = Number(first.value);
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await expect(collect(iterator)).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('keeps a command alive past the old deadline and completes after it is released', async () => {
    const { root } = await fixture('full-access');
    const controller = new AbortController();
    vi.useFakeTimers();
    const iterator = runCommand(
      'echo $$; while [ ! -f release ]; do sleep 0.01; done; printf completed',
      root,
      controller.signal,
    );
    try {
      const first = await iterator.next();
      const pid = Number(first.value);
      const result = collect(iterator);
      // 提前挂载拒绝处理，旧计时器若仍存在，测试也不会遗留未处理拒绝。
      void result.catch(() => {});
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(() => process.kill(pid, 0)).not.toThrow();
      await writeFile(join(root, 'release'), 'go');
      expect(await result).toMatchObject({ failed: false });
    } finally {
      controller.abort();
      await iterator.return({ content: '', failed: true });
      vi.useRealTimers();
    }
  });

  it('finishes noisy commands after truncating their captured logs instead of killing them', async () => {
    const { execute, root } = await fixture('full-access');
    const result = await execute('run_command', {
      command: "head -c 200000 /dev/zero | tr '\\000' x; printf finished; printf success > noisy-result.txt",
    });
    expect(result.failed).toBe(false);
    const details = JSON.parse(result.content);
    expect(details).toMatchObject({ exitCode: 0, truncated: true });
    expect(details.output.length).toBeLessThanOrEqual(64000);
    expect(details.output).toContain('finished');
    expect(await readFile(join(root, 'noisy-result.txt'), 'utf8')).toBe('success');
  });

  it('waits for approval beyond five minutes and still checks the file before writing', async () => {
    const { execute, run, pending, root, approvals, controller } = await fixture('workspace-write');
    vi.useFakeTimers();
    const result = execute('write_file', { path: 'hello.txt', content: 'approved later' });
    void result.catch(() => {});
    try {
      await pending;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(run.approvals[0]).toMatchObject({ status: 'pending', expiresAt: null });
      expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('before\n');
      approvals.decide(run.id, run.approvals[0]!.id, 'approved');
      expect((await result).failed).toBe(false);
      expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('approved later');
    } finally {
      controller.abort();
      await result.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('rejects invalid inputs instead of forwarding unknown parameters', async () => {
    const { execute } = await fixture();
    for (const request of [
      { name: 'read_file', input: { path: 'hello.txt', permissionMode: 'full-access' } },
      { name: 'unknown', input: {} },
      { name: 'search_files', input: { path: '.', query: '' } },
    ] satisfies Omit<ToolRequest, 'id'>[])
      expect((await execute(request.name, request.input)).failed).toBe(true);
  });
});
