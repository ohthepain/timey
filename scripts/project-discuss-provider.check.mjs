import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConnection } from './factory-ui/codex.mjs';
import { createProjectDiscussProvider } from './factory-ui/project-discuss-provider.mjs';

function fixture(t, hook = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'timey-discuss-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = (name, restricted = false) => {
    const directory = join(root, 'skills', name);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'SKILL.md');
    writeFileSync(
      path,
      `---\nname: ${name}\ndescription: Test ${name}\n${restricted ? 'disable-model-invocation: true\n' : ''}---\n\nTest instructions.\n`
    );
    return { name, path, enabled: true };
  };
  const skills = [skill('grilling'), skill('grill-with-docs', true)];
  const calls = [];
  const sent = [];
  const connection = {
    turns: new Map(),
    requests: new Map(),
    approvalReviewers: new Map(),
    ready: async () => {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [{ skills }] };
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'thread/read') return { thread: { id: 'thread', status: { type: this.status || 'idle' } } };
      return {};
    },
    async turn(threadId, cwd, prompt, schema, inputs, settings, receipt) {
      calls.push({ method: 'provider/turn', params: { threadId, cwd, prompt, schema, inputs, settings } });
      this.turns.set(threadId, { started: Promise.resolve({ turn: { id: 'turn' } }) });
      receipt.accepted({ turnId: 'turn' });
      await hook(connection);
      this.turns.delete(threadId);
      return 'Here is the answer.\n\n```timey-suggestion\nShow me the changes.\n```';
    },
    send(value) {
      sent.push(value);
    },
    answer: CodexConnection.prototype.answer,
    close() {},
  };
  const session = { id: 'chat', messages: [] };
  const message = {
    id: 'message',
    text: 'Read this project.',
    settings: { model: 'model', effort: 'high', clarificationSkill: 'grilling', skills: [] },
    attachments: [],
  };
  const events = [];
  const controller = new AbortController();
  const retained = [];
  const tools = {
    definitions: [{ type: 'function', name: 'known', description: 'Known', inputSchema: { type: 'object' } }],
    async invoke(name, input) {
      assert.equal(name, 'known');
      return { input };
    },
  };
  const provider = createProjectDiscussProvider({ root }, { connection, tools });
  const context = {
    signal: controller.signal,
    event: (event) => events.push(event),
    retain: (patch) => {
      retained.push(patch);
      Object.assign(session, patch);
    },
  };
  return { root, provider, connection, session, message, context, events, calls, sent, retained, tools };
}

test('project provider uses current folder, writable permission guards, conditional skills and same-turn suggestion', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  const result = await f.provider.turn(f.session, f.message, f.context);
  assert.deepEqual(result, { text: 'Here is the answer.', suggestion: 'Show me the changes.' });
  const start = f.calls.find(({ method }) => method === 'thread/start').params;
  assert.equal(start.cwd, f.root);
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.deepEqual(start.dynamicTools, f.tools.definitions);
  assert.match(start.developerInstructions, /only when intent remains ambiguous/);
  assert.ok(!start.developerInstructions.includes('"name":"grill-with-docs"'));
  assert.deepEqual(f.calls.find(({ method }) => method === 'provider/turn').params.inputs, []);
  assert.equal(f.session.threadId, 'thread');
  assert.equal(f.session.turnId, 'turn');
  const skills = await f.provider.skills();
  assert.equal(skills.find(({ name }) => name === 'grill-with-docs').allowImplicitInvocation, false);
});

test('explicit-only selections and retained images/files are actual native turn input', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'retained.txt');
  writeFileSync(path, 'Original attachment contents.');
  f.message.settings.skills = ['grill-with-docs'];
  f.message.settings.clarificationSkill = 'grill-with-docs';
  f.message.attachments = [
    { name: 'input.txt', mime: 'text/plain', path },
    { name: 'image.png', mime: 'image/png', path: '/retained/image.png' },
  ];
  await f.provider.turn(f.session, f.message, f.context);
  const input = f.calls.find(({ method }) => method === 'provider/turn').params.inputs;
  assert.equal(input[0].type, 'skill');
  assert.equal(input[0].name, 'grill-with-docs');
  assert.match(input[1].text, /Original attachment contents/);
  assert.deepEqual(input[2], { type: 'localImage', path: '/retained/image.png' });
});

test('project resume refuses uncertain startup or an active original native turn', async (t) => {
  const f = fixture(t);
  f.session.startup = { status: 'waiting' };
  await assert.rejects(() => f.provider.turn(f.session, f.message, f.context), /creation is uncertain/);
  f.session.threadId = 'thread';
  f.connection.status = 'active';
  await assert.rejects(() => f.provider.turn(f.session, f.message, f.context), /not confirmed idle/);
  assert.ok(!f.calls.some(({ method }) => method === 'provider/turn'));
});

test('dynamic calls are bound to current thread and turn, retain receipts and never repeat a completed identity', async (t) => {
  let f;
  let executions = 0;
  f = fixture(t, async (connection) => {
    const request = {
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'known',
      arguments: { value: 1 },
    };
    await assert.rejects(() => connection.toolHandler({ ...request, threadId: 'other' }), /does not belong/);
    await assert.rejects(() => connection.toolHandler({ ...request, turnId: 'other' }), /different turn/);
    const result = await connection.toolHandler(request);
    assert.equal(result.success, true);
    assert.deepEqual(await connection.toolHandler(request), result);
    await assert.rejects(() => connection.toolHandler({ ...request, arguments: { value: 2 } }), /different arguments/);
    f.session.toolReceipts['turn:uncertain'] = { fingerprint: 'unused', status: 'dispatching' };
  });
  f.tools.invoke = async () => {
    executions++;
    return { status: 'accepted' };
  };
  await f.provider.turn(f.session, f.message, f.context);
  assert.equal(executions, 1);
  assert.equal(f.session.toolReceipts['turn:call'].status, 'completed');
  assert.equal(f.events.filter(({ method }) => method === 'ui/projectTool').length, 2);
});

test('permissions expose actual offered choices and reject answers for other conversations', async (t) => {
  let f;
  f = fixture(t, async (connection) => {
    const request = {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', command: 'pnpm test', availableDecisions: ['accept', 'decline'] },
    };
    connection.requests.set('7', request);
    connection.onEvent({ method: 'ui/approval', params: { requestId: '7', ...request.params } });
    assert.equal(f.events.at(-1).params.options[0].id, 'option:0');
    assert.throws(
      () => f.provider.answer({ id: 'other', threadId: 'thread' }, '7', { decision: 'option:0' }),
      /another project conversation/
    );
    f.provider.answer(f.session, '7', { decision: 'option:1' });
    assert.deepEqual(f.sent.at(-1), { id: 7, result: { decision: 'decline' } });
  });
  await f.provider.turn(f.session, f.message, f.context);
});

test('Codex experimental support is opt-in for project tools', () => {
  assert.equal(new CodexConnection().experimentalApi, false);
  assert.equal(new CodexConnection({ experimentalApi: true }).experimentalApi, true);
});
