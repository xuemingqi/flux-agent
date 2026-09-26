import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

// 仅用于端到端测试的 OpenAI-compatible 服务；生产启动不会加载此文件。
const steeringGates = new Map();
const compressionGates = new Set();
const subagentGates = new Set();
const displayStreams = new Map();
const server = createServer(async (request, response) => {
  if (request.url === '/v1/models' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        data: [
          { id: 'fixture-model', context_length: 32768 },
          { id: 'updated-model', context_length: 262144 },
        ],
      }),
    );
    return;
  }
  if (request.url === '/advance-display' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { question, delta } = JSON.parse(body);
    const send = displayStreams.get(question);
    if (!send) response.writeHead(404).end();
    else {
      send(delta);
      response.end('ok');
    }
    return;
  }
  if (request.url === '/release-subagents' && request.method === 'POST') {
    for (const release of subagentGates) release();
    response.end('ok');
    return;
  }
  if (request.url === '/release-compression' && request.method === 'POST') {
    for (const release of compressionGates) release();
    response.end('ok');
    return;
  }
  if (request.url === '/release-steering' && request.method === 'POST') {
    steeringGates.get('answer')?.();
    response.end('ok');
    return;
  }
  if (request.url === '/health') {
    response.end('ok');
    return;
  }
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const content = input.messages.at(-1)?.content;
  const question = input.messages.findLast((message) => message.role === 'user')?.content;
  if (content === '模拟错误') {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'fixture-key must never leak', type: 'authentication_error' } }));
    return;
  }
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (delta, finishReason = null, usage) =>
    response.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`,
    );
  send({ role: 'assistant', content: '' });
  const collaborationTask = input.messages.find(
    (message) => message.role === 'user' && ['协作子任务 A', '协作子任务 B'].includes(message.content),
  )?.content;
  if (question === '协作交流测试' || collaborationTask) {
    const call = (name, args) =>
      send({
        tool_calls: [
          { index: 0, id: 'collaboration-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      });
    let toolCall = false;
    if (!collaborationTask) {
      if (input.messages.at(-1)?.role === 'tool') send({ content: '两位同伴已交换意见，主 Agent 已汇总复核结果。' });
      else {
        call('delegate_tasks', {
          mode: 'parallel',
          tasks: [
            { name: '实现伙伴', task: '协作子任务 A' },
            { name: '审查伙伴', task: '协作子任务 B' },
          ],
        });
        toolCall = true;
      }
    } else {
      const isA = collaborationTask.endsWith('A');
      const incoming = input.messages.some(
        (message) => message.role === 'user' && String(message.content).includes('来自同伴 Agent'),
      );
      const sent = input.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((call) => call.function?.name === 'send_agent_message'),
      );
      if (!sent && (isA || incoming)) {
        const rosterText = String(input.messages[0].content).match(/同伴地址簿[^\n]*：(\[[^\n]*\])/)[1];
        const peer = JSON.parse(rosterText)[0];
        call('send_agent_message', {
          toAgentId: peer.id,
          content: isA
            ? '我完成了接口实现，请帮忙复核空输入的处理。'
            : '已复核：空输入应返回明确提示，我把检查结果发给你。',
        });
        toolCall = true;
      } else if (!incoming) {
        call('receive_agent_messages', { waitMs: 1000 });
        toolCall = true;
      } else {
        const gate = Promise.withResolvers();
        subagentGates.add(gate.resolve);
        response.once('close', gate.resolve);
        send({ reasoning_content: '已读到同伴的建议，正在整理协作结果。' });
        await gate.promise;
        subagentGates.delete(gate.resolve);
        if (response.destroyed) return;
        send({ content: isA ? '已根据审查伙伴建议补充空输入处理。' : '已向实现伙伴反馈复核结果。' });
      }
    }
    send({}, toolCall ? 'tool_calls' : 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '持续滚动测试' || question === '思考预览测试') {
    displayStreams.set(question, send);
    response.once('close', () => displayStreams.delete(question));
    send(
      question === '持续滚动测试'
        ? {
            content: Array.from(
              { length: 45 },
              (_, index) => `第 ${index + 1} 段：持续输出时可以向上阅读历史。\n\n`,
            ).join(''),
          }
        : { reasoning_content: `思考起点。${'先检查已有信息，再分析下一步。'.repeat(35)}当前思考末尾。` },
    );
    return;
  }
  if (input.messages[0]?.content.includes('你是会话上下文压缩器')) {
    if (String(content).includes('等待压缩测试')) {
      const gate = Promise.withResolvers();
      compressionGates.add(gate.resolve);
      response.once('close', gate.resolve);
      await gate.promise;
      compressionGates.delete(gate.resolve);
      if (response.destroyed) return;
    }
    send({ content: '历史任务代号 orchid，用户希望保留该代号并继续讨论。' });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '多 Agent 测试') {
    if (input.messages.at(-1)?.role === 'tool') send({ content: '两个子 Agent 已完成，主 Agent 已汇总。' });
    else
      send({
        tool_calls: [
          {
            index: 0,
            id: 'delegate-test',
            type: 'function',
            function: {
              name: 'delegate_tasks',
              arguments: JSON.stringify({
                mode: 'parallel',
                tasks: [
                  { name: '分析 A', task: '子任务读取 A' },
                  { name: '分析 B', task: '子任务读取 B' },
                ],
              }),
            },
          },
        ],
      });
    send({}, input.messages.at(-1)?.role === 'tool' ? 'stop' : 'tool_calls');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '子任务读取 A' || question === '子任务读取 B') {
    if (input.messages.at(-1)?.role === 'tool') {
      if (question === '子任务读取 B') {
        const gate = Promise.withResolvers();
        subagentGates.add(gate.resolve);
        response.once('close', gate.resolve);
        send({ reasoning_content: '正在整理子任务结果。' });
        await gate.promise;
        subagentGates.delete(gate.resolve);
        if (response.destroyed) return;
      }
      const reasoning = input.messages.findLast((message) => message.role === 'assistant')?.reasoning_content;
      send({ content: reasoning === `${question}的思考` ? `${question}完成。` : '缺少子任务的思考上下文' });
    } else {
      send({ reasoning_content: `${question}的思考` });
      send({
        tool_calls: [
          {
            index: 0,
            id: 'shared-read-id',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
          },
        ],
      });
    }
    send({}, input.messages.at(-1)?.role === 'tool' ? 'stop' : 'tool_calls');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '复述历史代号') {
    send({
      content: input.messages.some((message) => String(message.content).includes('orchid'))
        ? '历史代号是 orchid。'
        : '缺少历史代号',
    });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '插话测试') {
    const gate = Promise.withResolvers();
    steeringGates.set('answer', gate.resolve);
    response.once('close', gate.resolve);
    send({ content: '正在生成初稿。' });
    await gate.promise;
    steeringGates.delete('answer');
    if (response.destroyed) return;
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '改成三点摘要' || question === '不要修改，解释原因') {
    const original = input.messages.some(
      (message) => message.role === 'user' && ['插话测试', '拒绝测试修改'].includes(message.content),
    );
    const denied = input.messages.some(
      (message) => message.role === 'tool' && message.content.includes('APPROVAL_DENIED'),
    );
    send({
      content: !original
        ? '丢失原始任务'
        : question === '改成三点摘要'
          ? '已根据补充要求改成三点摘要。'
          : denied
            ? '已取消修改，文件保持原样。'
            : '缺少审批结果',
    });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '按计划读取测试文件' || question === '计划中途停止') {
    const latestUser = input.messages.findLastIndex((message) => message.role === 'user');
    const results = input.messages.slice(latestUser).filter((message) => message.role === 'tool');
    const stage = results.length;
    const steps = [
      { id: 'read', title: '读取测试文件', status: stage >= 2 ? 'completed' : 'in_progress' },
      { id: 'report', title: '整理读取结果', status: stage >= 2 ? 'completed' : 'pending' },
    ];
    const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
    if (stage && !system.includes('本轮最新任务计划')) {
      send({ content: '缺少最新计划上下文' });
      send({}, 'stop');
    } else if (stage === 1 && question === '计划中途停止') {
      // 持续流式输出，供刷新重连与取消测试观察执行中的计划。
      for (let index = 0; index < 200; index++) {
        if (response.destroyed) return;
        send({ reasoning_content: '等待进一步处理。' });
        await setTimeout(50);
      }
      send({}, 'stop');
    } else if (stage < 3) {
      const name = stage === 1 ? 'read_file' : 'update_plan';
      const args =
        stage === 1
          ? { path: 'hello.txt' }
          : {
              version: stage === 0 ? 0 : 1,
              explanation: stage === 0 ? '先读取文件，再整理结果。' : '文件已读取，结果已整理。',
              steps,
            };
      send({
        tool_calls: [
          { index: 0, id: `call-plan-${stage}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ content: '已按计划读取并整理测试文件。' });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  const fileTools = {
    列出测试目录: { name: 'list_directory', arguments: { path: '.' } },
    搜索测试文件: { name: 'search_files', arguments: { path: '.', query: 'preview needle' } },
    读取说明文件: { name: 'read_file', arguments: { path: 'README.md' } },
    读取空文件: { name: 'read_file', arguments: { path: 'empty.txt' } },
    读取失败测试: { name: 'read_file', arguments: { path: 'missing.txt' } },
    查询我的称呼: { name: 'search_memories', arguments: { query: '姓名 称呼' } },
    记住项目暗号: { name: 'propose_memory', arguments: { content: '项目暗号是 blue-sparrow。' } },
    读取测试文件: { name: 'read_file', arguments: { path: 'hello.txt' } },
    修改测试文件: { name: 'write_file', arguments: { path: 'hello.txt', content: 'approved content\n' } },
    拒绝测试修改: { name: 'write_file', arguments: { path: 'denied.txt', content: 'must not exist' } },
    运行测试命令: { name: 'run_command', arguments: { command: 'printf command-ok' } },
    持续命令输出: {
      name: 'run_command',
      arguments: {
        command: `node -e 'for(let i=0;i<60;i++) console.log("历史日志 "+i); let n=0; setInterval(()=>console.log("实时日志 "+(++n)),50)'`,
      },
    },
  };
  if (fileTools[question]) {
    if (input.messages.at(-1)?.role !== 'tool') {
      const call = fileTools[question];
      send({ reasoning_content: '使用当前工作区及用户选择的权限。' });
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call-file',
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ content: `工具返回：${content}` });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '查询当前时间' && input.messages.at(-1)?.role !== 'tool') {
    send({ reasoning_content: '我会先读取当前时间，' });
    send({ reasoning_content: '再根据工具结果回答。' });
    send({ content: '我先查询一下当前时间。' });
    send({
      tool_calls: [
        { index: 0, id: 'call-clock', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
      ],
    });
    send({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '项目暗号是什么') {
    const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
    send({ content: system.includes('项目暗号是 blue-sparrow') ? '记忆中的暗号：blue-sparrow' : '没有可用的暗号记忆' });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '你记得我是谁吗') {
    const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
    send({
      content: system.includes('用户姓名：林舟')
        ? '记得，你是林舟，可以称呼你小林。'
        : '当前工作区未找到你的已确认身份记忆。',
    });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '检查工具历史') {
    const calls = input.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.tool_calls ?? []);
    const results = input.messages.filter((message) => message.role === 'tool');
    const paired = calls.length > 0 && calls.every((call) => results.some((result) => result.tool_call_id === call.id));
    send({ content: paired ? '已接收完整工具历史' : '缺少工具历史' });
    send({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  if (question === '慢速思考') {
    for (let index = 0; index < 200; index++) {
      if (response.destroyed) return;
      send({ reasoning_content: index ? '继续分析。' : '先梳理问题的约束。' });
      await setTimeout(50);
    }
  }
  const answer =
    input.messages.at(-1)?.role === 'tool'
      ? [`查询完成。当前时间：${JSON.parse(content).localTime}。`, `\n\n时区：${JSON.parse(content).timeZone}。`]
      : content === '慢速回答'
        ? Array(200).fill('慢速输出。')
        : [
            '**你好**，',
            `这是第 ${input.messages.filter((message) => message.role === 'user').length} 轮回复。`,
            '\n\n<script>window.fluxXss = true</script>',
          ];
  for (const text of answer) {
    if (response.destroyed) return;
    send({ content: text });
    if (content === '慢速回答') await setTimeout(50);
  }
  send({}, 'stop');
  if (input.stream_options?.include_usage) {
    response.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      })}\n\n`,
    );
  }
  response.end('data: [DONE]\n\n');
});
server.listen(4319, '127.0.0.1');
process.once('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
