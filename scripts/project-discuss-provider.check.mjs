import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConnection } from './factory-ui/codex.mjs';
import { desktopThreadWriter } from './factory-ui/codex-thread-writer.mjs';
import { createProjectDiscussProvider } from './factory-ui/project-discuss-provider.mjs';

function fixture(t, hook = async () => {}, { useProjectTools = false, ...providerOptions } = {}) {
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
  const provider = createProjectDiscussProvider(
    { root },
    { connection, ...providerOptions, ...(useProjectTools ? {} : { tools }) }
  );
  const context = {
    signal: controller.signal,
    event: (event) => events.push(event),
    retain: (patch) => {
      retained.push(patch);
      Object.assign(session, patch);
    },
  };
  return { root, provider, connection, session, message, context, controller, events, calls, sent, retained, tools };
}

void test('a new Discuss chat registers the server’s current issue tools on its first message', async (t) => {
  const f = fixture(t, undefined, { useProjectTools: true });
  await f.provider.turn(f.session, f.message, f.context);
  const { dynamicTools } = f.calls.find(({ method }) => method === 'thread/start').params;
  for (const name of ['issue_move_folder', 'issue_group_preview', 'issue_group_create'])
    assert.ok(
      dynamicTools.some((tool) => tool.name === name),
      name
    );
  assert.ok(dynamicTools.find(({ name }) => name === 'issue_create').inputSchema.properties.storageProfile);
});

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

test('an explicit provider change retains the old conversation and supplies handoff context', async (t) => {
  const f = fixture(t);
  f.session.threadId = 'original-codex';
  f.session.messages = [{ role: 'user', text: 'Keep the existing public API.' }];
  f.provider.active = { ...f.context, session: f.session, message: f.message };
  await f.provider.selectAgent(f.session, { model: 'anthropic:sonnet' });
  assert.equal(f.session.threadId, null);
  assert.equal(f.session.priorConversations[0].threadId, 'original-codex');
  assert.match(f.provider.active.message.text, /Keep the existing public API/);
  assert.match(f.provider.active.message.text, /Full retained history/);
  assert.equal(f.provider.connection.selection.provider, 'anthropic');
  assert.equal(f.provider.connection.process, undefined, 'Choosing an agent alone starts no model turn.');
  f.provider.close();
});

test('handoff refuses an active original conversation and native skill discovery needs no Codex process', async (t) => {
  const f = fixture(t);
  const before = f.calls.length;
  await f.provider.skills('google:pro');
  assert.equal(f.calls.length, before);
  f.session.threadId = 'original-codex';
  f.connection.status = 'active';
  f.provider.active = { ...f.context, session: f.session, message: f.message };
  await assert.rejects(f.provider.selectAgent(f.session, { model: 'google:pro' }), /Stop or reconcile/);
  assert.equal(f.session.threadId, 'original-codex');
  assert.equal(f.session.priorConversations, undefined);
});

test('a prepared local note reaches the provider only with the later explicit prompt', async (t) => {
  const f = fixture(t);
  f.session.noteContext = { id: 'note', text: 'Keep this thought', issueId: '20261120-note' };
  assert.deepEqual(f.calls, []);
  await f.provider.turn(f.session, f.message, f.context);
  const prompt = f.calls.find(({ method }) => method === 'provider/turn').params.prompt;
  assert.match(prompt, /Keep this thought/);
  assert.match(prompt, /20261120-note/);
  assert.match(prompt, /Current request:\nRead this project\./);
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

test('Discuss waits for a desktop-held thread, then sends the saved prompt once on that thread', async (t) => {
  const f = fixture(t, undefined, {
    threadWriterOwner: async () => 'ChatGPT desktop app',
    threadWriterDelay: async () => {},
  });
  f.session.threadId = '01a2146c-da41-7d21-a874-231f31fa5422';
  const call = f.connection.call.bind(f.connection);
  let blocked = true;
  f.connection.call = async (method, params) => {
    if (method === 'thread/resume' && blocked) {
      blocked = false;
      throw Error('thread already has an active writer');
    }
    return call(method, params);
  };
  assert.equal((await f.provider.turn(f.session, f.message, f.context)).text, 'Here is the answer.');
  assert.ok(f.retained.some(({ threadLock }) => threadLock?.includes('ChatGPT desktop app')));
  assert.equal(f.session.threadLock, null);
  const turns = f.calls.filter(({ method }) => method === 'provider/turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].params.threadId, f.session.threadId);
});

test('stopping a Discuss lock wait leaves the original thread and sends no prompt', async (t) => {
  const f = fixture(t, undefined, {
    threadWriterOwner: async () => undefined,
    threadWriterDelay: async () => f.controller.abort(),
  });
  f.session.threadId = '01a2146c-da41-7d21-a874-231f31fa5422';
  const call = f.connection.call.bind(f.connection);
  f.connection.call = async (method, params) => {
    if (method === 'thread/resume') throw Error('thread already has an active writer');
    return call(method, params);
  };
  await assert.rejects(() => f.provider.turn(f.session, f.message, f.context), { name: 'AbortError' });
  assert.ok(f.retained.some(({ threadLock }) => threadLock?.includes('another Codex session')));
  assert.ok(!f.calls.some(({ method }) => ['thread/start', 'provider/turn'].includes(method)));
});

test('a persistent Discuss lock ends with a useful Retry message and no model turn', async (t) => {
  const f = fixture(t, undefined, {
    threadWriterOwner: async () => 'the ChatGPT desktop app',
    threadWriterDelay: async () => {},
  });
  f.session.threadId = '01a2146c-da41-7d21-a874-231f31fa5422';
  const call = f.connection.call.bind(f.connection);
  f.connection.call = async (method, params) => {
    if (method === 'thread/resume') throw Error('thread already has an active writer');
    return call(method, params);
  };
  await assert.rejects(() => f.provider.turn(f.session, f.message, f.context), /ChatGPT desktop app.*Retry/);
  assert.equal(f.session.threadLock, null);
  assert.ok(!f.calls.some(({ method }) => ['thread/start', 'provider/turn'].includes(method)));
});

test('a single desktop lock holder is named and ambiguous holders are left unidentified', async () => {
  const thread = '01a2146c-da41-7d21-a874-231f31fa5422';
  const lookup = (holders) =>
    desktopThreadWriter(thread, {
      platform: 'darwin',
      async execute(command, args) {
        if (command === '/usr/sbin/lsof') {
          assert.ok(args.at(-1).endsWith(`/thread-writer-locks/${thread}.lock`));
          return { stdout: holders };
        }
        assert.deepEqual(args, ['-ww', '-p', '84565', '-o', 'comm=']);
        return { stdout: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n' };
      },
    });
  assert.equal(await lookup('p84565\nf82\n'), 'the ChatGPT desktop app');
  assert.equal(await lookup('p84565\nf82\np94565\nf17\n'), undefined);
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

test('concurrent Stop signals interrupt the exact native turn only once', async (t) => {
  const f = fixture(t);
  f.session.threadId = 'thread';
  f.connection.turns.set('thread', { started: Promise.resolve({ turn: { id: 'turn' } }) });
  await Promise.all([f.provider.stop(f.session), f.provider.stop(f.session)]);
  assert.equal(f.calls.filter(({ method }) => method === 'turn/interrupt').length, 1);
});

test('No Grilling reaches the model without any installed clarification skills', async (t) => {
  const f = fixture(t);
  const call = f.connection.call.bind(f.connection);
  f.connection.call = (method, params) => (method === 'skills/list' ? { data: [] } : call(method, params));
  f.message.settings.clarificationSkill = 'none';
  await f.provider.turn(f.session, f.message, f.context);
  assert.ok(f.calls.some(({ method }) => method === 'provider/turn'));
  const start = f.calls.find(({ method }) => method === 'thread/start');
  assert.match(start.params.developerInstructions, /No Grilling: do not invoke/);
  assert.match(start.params.developerInstructions, /Factory does not provide a native Skill tool/);
  assert.doesNotMatch(start.params.developerInstructions, /Explicitly chosen clarification skill/);
});

test('missing selected clarification skill fails before starting a model turn', async (t) => {
  const f = fixture(t);
  f.message.settings.clarificationSkill = 'grill-me';
  await assert.rejects(f.provider.turn(f.session, f.message, f.context), /Choose No Grilling or set up skills/);
  assert.ok(!f.calls.some(({ method }) => method === 'thread/start'));
});

test('Issue Discuss sends the Issue chat prompt with the current request and flow status', async (t) => {
  const issue = { id: 'selected-issue', title: 'Selected issue', state: 'backlog' };
  const flow = {
    blocks: [
      {
        id: 'request',
        kind: 'request',
        label: 'Request',
        data: { wording: 'Preserve the original wording' },
        attempts: [],
      },
      { id: 'work', kind: 'work', label: 'Work', attempts: [{ status: 'blocked', summary: 'Waiting for review' }] },
    ],
  };
  const f = fixture(t, undefined, {
    flows: () => ({ selected: () => issue, read: () => flow }),
    useProjectTools: true,
  });
  mkdirSync(join(f.root, 'user'), { recursive: true });
  writeFileSync(
    join(f.root, 'user/factory-preferences.json'),
    JSON.stringify({ prompts: { issue: 'Configured Issue prompt' } })
  );
  f.session.ownership = { kind: 'issue', issueId: issue.id };
  await f.provider.turn(f.session, f.message, f.context);
  const started = f.calls.find(({ method }) => method === 'thread/start').params;
  assert.match(started.developerInstructions, /^Configured Issue prompt/);
  assert.equal(started.approvalPolicy, 'on-request');
  assert.ok(started.dynamicTools.some(({ name }) => name === 'issue_control'));
  const { prompt } = f.calls.find(({ method }) => method === 'provider/turn').params;
  assert.match(prompt, /"id":"selected-issue"/);
  assert.match(prompt, /Preserve the original wording/);
  assert.match(prompt, /"status":"blocked","summary":"Waiting for review"/);
});
