import { createFactoryServer } from './factory-ui/http.mjs';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './factory-ui/common.mjs';
import { currentNotes, retainNotes } from './factory-ui/coordinator-notes.mjs';
import { createCoordinator } from './factory-ui/coordinator.mjs';
import { createIssueChatConnection } from './factory-ui/issue-chat-runtime.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-coordinator-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [],
    runs = [],
    connected = new Set();
  const service = {
    root,
    lifecycleRuns: {
      one: { issueId: 'one', input: { question: 'Pending decision?' }, approval: { sha256: 'approved' } },
    },
    lifecycleTasks: new Map(),
    ownServer() {},
    pauseLifecycle({ issueId }) {
      calls.push(['pause', issueId]);
    },
    continueCoordinatorIssue(id) {
      calls.push(['continue', id]);
    },
    store: {
      runs,
      connected,
      event(event) {
        calls.push(['event', event.method]);
      },
      update(run, values) {
        Object.assign(run, values);
      },
      add(_action, kind) {
        const run = { id: String(runs.length), kind };
        runs.push(run);
        connected.add(run.id);
        return run;
      },
    },
  };
  let serial = 0;
  const connection = {
    close() {},
    async attach(_root, state, retain) {
      calls.push(['attach', state.threadId]);
      const id = state.threadId || 'native-' + ++serial;
      retain({ threadId: id });
      return id;
    },
    async turn(id, _root, prompt) {
      calls.push(['turn', id, prompt]);
      connection.onEvent({ method: 'turn/started', params: { threadId: id, turn: { id: 'turn-' + serial } } });
      return 'Saved response';
    },
    async interrupt(id) {
      calls.push(['interrupt', id]);
    },
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'thread/read') return { thread: { cwd: root, status: { type: 'idle' } } };
    },
  };
  const owner = createCoordinator(service, () => connection);
  service.coordinator = owner;
  t.after(() => owner.close());
  return { root, calls, service, connection, owner, run: { id: 'review-one', issueId: 'one' } };
}
test('reading coordinator state starts no connection and transport rejects permission requests', (t) => {
  const f = fixture(t);
  assert.equal(f.owner.view().active, null);
  assert.equal(f.calls.length, 0);
  const connection = createIssueChatConnection();
  let reply;
  connection.send = (message) => {
    reply = message;
  };
  connection.request({ id: 1, method: 'item/commandExecution/requestApproval' });
  assert.equal(reply.error.code, -32601);
  assert.equal(connection.child, undefined);
});
test('queue operations share one conversation, serialize and retain issue-linked live output', async (t) => {
  const f = fixture(t);
  let release;
  f.connection.turn = async () => {
    f.connection.onEvent({ method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'Reviewing one' } });
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = f.owner.turn(f.run, 'First limited task');
  await tick();
  const second = f.owner.turn({ id: 'two', issueId: 'two' }, 'Second task');
  assert.equal(f.owner.view().active.issueId, 'one');
  assert.match(f.owner.view().waiting[0].reason, /finishing/);
  assert.equal(f.owner.view().threads[0].output[0].text, 'Reviewing one');
  assert.throws(() => f.owner.fresh(), /only while idle/);
  await f.owner.message({ id: 'queued-for-next-operation', mode: 'send', text: 'Explain the next operation' });
  let secondPrompt;
  f.connection.turn = async (_id, _root, prompt) => {
    secondPrompt = prompt;
    return 'Second response';
  };
  release('First response');
  await Promise.all([first, second]);
  const state = JSON.parse(readFileSync(join(f.root, '.issues/factory-ui/coordinator.json')));
  assert.match(secondPrompt, /Explain the next operation/);
  assert.equal(f.owner.view().pending, 0);
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].messages.filter((m) => m.role === 'Coordinator').length, 2);
  assert.equal(state.threads[0].messages.at(-1).issueId, 'two');
});
test('Stop interrupts only coordination, blocks next operations, and Continue uses existing issue handlers', async (t) => {
  const f = fixture(t);
  let reject;
  f.service.lifecycleTasks.set('one', Promise.resolve());
  const worker = { id: 'worker', kind: 'worker', issueId: 'one', status: 'running' };
  f.service.store.runs.push(worker);
  f.service.store.connected.add(worker.id);
  f.connection.turn = async (threadId) => {
    f.connection.onEvent({ method: 'turn/started', params: { threadId, turn: { id: 'current' } } });
    return new Promise((_resolve, no) => {
      reject = no;
    });
  };
  const task = f.owner.turn(f.run, 'Limited task');
  task.catch(() => {});
  await tick();
  f.connection.interrupt = async (id) => {
    f.calls.push(['interrupt', id]);
    reject(Error('Response stopped'));
  };
  await f.owner.stop();
  await assert.rejects(task, /stopped/);
  assert.equal(worker.status, 'running');
  assert.equal(f.owner.view().workers.length, 1);
  await assert.rejects(f.owner.turn(f.run, 'No implicit resume'), /paused/);
  f.service.lifecycleTasks.clear();
  await f.owner.continue();
  assert.ok(f.calls.some((call) => call[0] === 'continue' && call[1] === 'one'));
});
test('Send waits for the next response, Steer requires the exact current turn, and messages confer no authority', async (t) => {
  const f = fixture(t);
  let release;
  f.connection.turn = async (threadId, _root, prompt) => {
    f.calls.push(['prompt', prompt]);
    f.connection.onEvent({ method: 'turn/started', params: { threadId, turn: { id: 'exact-turn' } } });
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const task = f.owner.turn(f.run, 'Original approved task');
  await tick();
  await assert.rejects(
    f.owner.message({ id: 'stale', mode: 'steer', text: 'Do more', turnId: 'old' }),
    /no longer active/
  );
  await f.owner.message({ id: 'steer', mode: 'steer', text: 'Explain the wait', turnId: 'exact-turn' });
  assert.equal(f.calls.find((c) => c[0] === 'turn/steer')[1].expectedTurnId, 'exact-turn');
  await f.owner.message({ id: 'next', mode: 'send', text: 'Approve everything' });
  assert.equal(f.owner.view().pending, 1);
  f.connection.turn = async (_id, _root, prompt) => {
    f.calls.push(['prompt', prompt]);
    return 'Discussion only';
  };
  release('Done');
  await task;
  await tick();
  await tick();
  assert.ok(
    f.calls.some((c) => c[0] === 'prompt' && /Do not edit, run checks, launch, change stages, approve/.test(c[1]))
  );
  assert.deepEqual(f.service.lifecycleRuns.one.approval, { sha256: 'approved' });
  await assert.rejects(
    f.owner.message({ id: 'late', mode: 'steer', text: 'Late', turnId: 'exact-turn' }),
    /no longer active/
  );
});
test('renewal retains history and current questions; restart pauses without replaying operations', async (t) => {
  const f = fixture(t);
  await f.owner.turn(f.run, 'First task');
  f.owner.state.threads[0].characters = 120000;
  await f.owner.turn(f.run, 'Second task');
  assert.equal(f.owner.view().threads.length, 2);
  assert.equal(f.owner.state.threads[1].handoff.records, undefined);
  assert.match(f.owner.state.threads[1].handoff.workingNotes, /coordinator-notes.json$/);
  assert.ok(f.owner.state.threads[0].archived);
  assert.deepEqual(f.service.lifecycleRuns.one.approval, { sha256: 'approved' });
  await f.owner.fresh();
  assert.equal(f.owner.view().threads.length, 3);
  f.owner.state.active = { issueId: 'one', operation: 'Saving', runId: 'old-operation' };
  f.owner.save();
  const restarted = createCoordinator(f.service, () => f.connection);
  t.after(() => restarted.close());
  const before = f.calls.length;
  assert.equal(restarted.view().paused, true);
  assert.equal(f.calls.length, before);
  assert.equal(restarted.view().interrupted.runId, 'old-operation');
  await restarted.continue();
  assert.equal(restarted.view().paused, false);
  assert.ok(f.calls.some((c) => c[0] === 'continue' && c[1] === 'one'));
});

test('HTTP coordinator reads start no work, actions require local session and origin, and stale steering fails', async (t) => {
  const f = fixture(t);
  Object.assign(f.service, {
    reviewMode: 'live',
    discussions: { sessions: new Map() },
    codex: { requests: new Map() },
  });
  const server = createFactoryServer(f.service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  await page.text();
  assert.equal((await fetch(url + '/api/coordinator')).status, 400);
  const headers = { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' };
  assert.equal((await fetch(url + '/api/coordinator', { headers })).status, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await fetch(url + '/api/coordinator-stop', {
        method: 'POST',
        headers: { ...headers, origin: 'https://invalid.example' },
        body: '{}',
      })
    ).status,
    400
  );
  assert.equal(f.owner.paused, false);
  assert.equal(
    (
      await fetch(url + '/api/coordinator-send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'steer', id: 'stale-http', text: 'Approve', turnId: 'old' }),
      })
    ).status,
    400
  );
  assert.equal((await fetch(url + '/api/coordinator-stop', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(f.owner.paused, true);
});

test('native RPC fixture exercises shared read-only transport, steering and interruption without live models', async (t) => {
  const f = fixture(t),
    path = join(f.root, 'provider.mjs');
  const log = process.env.TIMEY_COORDINATOR_RPC_LOG || join(f.root, 'provider.jsonl');
  writeFileSync(
    path,
    `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
let current; const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n'); if(!m.method||m.id===undefined)return;
 if(m.method==='initialize') return send({id:m.id,result:{}});
 if(m.method==='thread/name/set'||m.method==='thread/archive') return send({id:m.id,result:{}});
 if(m.method==='thread/start') return send({id:m.id,result:{thread:{id:'queue-native'}}});
 if(m.method==='thread/resume') return send({id:m.id,result:{thread:{id:'queue-native'}}});
 if(m.method==='thread/read') return send({id:m.id,result:{thread:{id:'queue-native',cwd:${JSON.stringify(f.root)},status:{type:'idle'}}}});
 if(m.method==='turn/start'){ current=m.params.threadId;send({id:m.id,result:{turn:{id:'native-turn'}}}); send({method:'turn/started',params:{threadId:current,turn:{id:'native-turn'}}}); send({method:'item/agentMessage/delta',params:{threadId:current,itemId:'native-output',delta:'Retained live output'}});return; }
 if(m.method==='turn/steer') return send({id:m.id,result:{turnId:'native-turn'}});
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return send({method:'turn/completed',params:{threadId:current,turn:{id:'native-turn',status:'interrupted'}}});}
 send({id:m.id,error:{message:'Unexpected fixture RPC: '+m.method}});
});`
  );
  const owner = createCoordinator(f.service, () => {
    const connection = createIssueChatConnection();
    connection.command = process.execPath;
    connection.args = [path];
    return connection;
  });
  t.after(() => owner.close());
  const turn = owner.turn(f.run, 'Hold this bounded read-only coordination response');
  turn.catch(() => {});
  for (let n = 0; n < 100 && !owner.view().active?.turnId; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(owner.view().active.turnId, 'native-turn');
  await owner.message({ id: 'native-steer', mode: 'steer', text: 'Explain the wait', turnId: 'native-turn' });
  await owner.stop();
  await assert.rejects(turn, /stopped/);
  const rpc = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rpc.find((m) => m.method === 'thread/start').params.sandbox, 'read-only');
  assert.match(rpc.find((m) => m.method === 'thread/name/set').params.name, / coordinator$/);
  assert.equal(rpc.find((m) => m.method === 'turn/steer').params.expectedTurnId, 'native-turn');
  assert.equal(rpc.find((m) => m.method === 'turn/interrupt').params.threadId, 'queue-native');
  assert.match(owner.view().threads[0].output[0].text, /Retained live output/);
});

test('large unrelated plans stay out of prompts and cumulative billing does not replace small chats', async (t) => {
  const f = fixture(t);
  f.service.lifecycleRuns.other = { issueId: 'other', plan: { content: 'UNRELATED PLAN '.repeat(20000) } };
  const original = f.connection.turn;
  f.connection.turn = async (...args) => {
    const text = await original(...args);
    f.owner.event({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { last: { inputTokens: 2000, outputTokens: 100 }, total: { totalTokens: 900000 } } },
    });
    return text;
  };
  for (let n = 0; n < 4; n++) await f.owner.turn(f.run, 'Review the selected issue');
  const prompts = f.calls.filter((call) => call[0] === 'turn').map((call) => call[2]);
  assert.equal(f.owner.state.threads.length, 1);
  assert.ok(prompts.every((prompt) => prompt.length < 6000));
  assert.ok(prompts.every((prompt) => !prompt.includes('UNRELATED PLAN') && !prompt.includes('Pending decision?')));
  assert.match(prompts[0], /lifecycle.json/);
  assert.match(prompts[0], /progressSelector/);
  assert.match(prompts[0], /one.md/);
  assert.match(prompts[0], /working_notes/);
});

test('current context and tool-output fallback rotate only between operations', async (t) => {
  const f = fixture(t);
  const original = f.connection.turn;
  let operation = 0;
  f.connection.turn = async (...args) => {
    const text = await original(...args);
    if (++operation === 1)
      f.owner.event({
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: { inputTokens: 21000, outputTokens: 100 }, total: { totalTokens: 999999 } } },
      });
    if (operation === 2)
      f.owner.event({
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'tool', delta: 'x'.repeat(65000) },
      });
    return text;
  };
  await f.owner.turn(f.run, 'First');
  await f.owner.turn(f.run, 'Second');
  assert.equal(f.owner.state.threads.length, 2);
  const attach = f.calls.findIndex(
    (call) => call[0] === 'attach' && call[1] === undefined && f.calls.indexOf(call) > 0
  );
  const archived = f.calls.findIndex((call) => call[0] === 'thread/archive');
  assert.ok(attach < archived);
  assert.match(f.owner.state.threads[0].title, /archived/);
  await f.owner.turn(f.run, 'Third');
  assert.equal(f.owner.state.threads.length, 3);
});

test('fresh chats carry validated computed notes, never chat history; changed sources discard affected notes', async (t) => {
  const f = fixture(t),
    path = join(f.root, 'source.md'),
    other = join(f.root, 'other.md');
  writeFileSync(path, 'current source');
  writeFileSync(other, 'unchanged');
  const source = { path, sha256: digest(readFileSync(path)) };
  const note = { finding: 'Two operations share one underlying cause.', sources: [source] };
  f.connection.turn = async () => JSON.stringify({ reply: 'Done', working_notes: [note] });
  assert.equal(await f.owner.turn(f.run, 'Analyze'), 'Done');
  retainNotes(f.root, 'two', [
    { finding: 'Independent finding', sources: [{ path: other, sha256: digest(readFileSync(other)) }] },
  ]);
  await f.owner.fresh();
  let received;
  f.connection.turn = async (_id, _root, prompt) => {
    received = prompt;
    return JSON.stringify({ reply: 'Continued', working_notes: [note] });
  };
  await f.owner.turn(f.run, 'Continue');
  assert.match(received, /Two operations share one underlying cause/);
  assert.doesNotMatch(received, /Independent finding/);
  assert.doesNotMatch(received, /\"role\":\"Coordinator\"/);
  writeFileSync(path, 'changed source');
  assert.equal(currentNotes(f.root, 'one').length, 0);
  assert.equal(currentNotes(f.root, 'two').length, 1);
  retainNotes(f.root, 'one', [
    { finding: 'Unsafe pointer', sources: [{ path: '/etc/passwd', sha256: '0'.repeat(64) }] },
  ]);
  assert.equal(currentNotes(f.root, 'one').length, 0);
});

test('failed replacement attachment never archives a predecessor; archival failure retains history and permits work', async (t) => {
  const f = fixture(t);
  await f.owner.turn(f.run, 'Initial');
  const attach = f.connection.attach;
  f.connection.attach = async () => {
    throw Error('startup uncertain');
  };
  await assert.rejects(f.owner.fresh(), /startup uncertain/);
  assert.equal(f.calls.filter((call) => call[0] === 'thread/archive').length, 0);
  f.connection.attach = attach;
  await f.owner.continue();
  const call = f.connection.call;
  f.connection.call = async (method, params) => {
    if (method === 'thread/archive') throw Error('Provider temporarily unavailable');
    return call(method, params);
  };
  await f.owner.turn(f.run, 'Retain and continue');
  assert.equal(f.owner.state.threads[0].archived, undefined);
  assert.match(f.owner.state.threads[0].archiveError, /temporarily unavailable/);
  assert.equal(f.owner.state.threads.at(-1).messages.length, 1);
});

test('real evaluation path references huge selected reports and other plans instead of copying them', async (t) => {
  const { captureFixture } = await import('./factory-capture-fixture.mjs');
  const { readQueue } = await import('./factory-ui/data.mjs');
  const f = captureFixture(t),
    issueId = '20261025-existing';
  writeFileSync(
    join(f.root, '.issues', issueId + '.md'),
    readFileSync(join(f.root, '.issues', issueId + '.md'), 'utf8') + '\nREPORT_ONLY_SENTINEL '.repeat(15000)
  );
  f.service.lifecycleRuns.other = { issueId: 'other', plan: { content: 'OTHER_PLAN_SENTINEL '.repeat(15000) } };
  f.service.ownServer = () => {};
  f.service.codex.start = async () => 'evaluation-thread';
  f.service.codex.call = async () => ({});
  let captured;
  f.service.codex.turn = async (_id, _cwd, prompt) => {
    captured = prompt;
    return JSON.stringify({
      summary: 'Read current sources.',
      recommendations: [],
      routes: [],
      next_step: 'Wait',
      continuation: null,
      record_update: null,
      human_question: null,
      next_action: 'blocked',
      working_notes: [],
    });
  };
  const run = f.service.evaluate(digest(JSON.stringify(readQueue(f.root))), issueId);
  for (let n = 0; n < 200 && f.service.store.connected.has(run.runId); n++) await tick();
  const saved = f.service.store.runs.find((r) => r.id === run.runId);
  assert.equal(saved.status, 'completed', saved.summary);
  assert.ok(captured.length < 14000, 'Actual evaluation prompt must stay bounded: ' + captured.length);
  assert.doesNotMatch(captured, /REPORT_ONLY_SENTINEL|OTHER_PLAN_SENTINEL/);
  assert.match(captured, /context.json/);
  assert.match(captured, /coordinator-index.json/);
});

test('Start fresh names and archives through RPC without starting a model turn', async (t) => {
  const f = fixture(t);
  await f.owner.turn(f.run, 'One operation');
  const before = f.calls.filter((call) => call[0] === 'turn').length;
  assert.deepEqual(await f.owner.fresh(), { renewed: true });
  assert.equal(f.calls.filter((call) => call[0] === 'turn').length, before);
  assert.ok(f.owner.state.threads[0].archived);
  assert.match(f.owner.state.threads.at(-1).title, / coordinator$/);
});
