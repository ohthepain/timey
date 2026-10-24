import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { gitFixture } from './git-fixture.mjs';
import { factory } from './factory.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { CodexConnection } from './factory-ui/codex.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { checkCandidate } from './factory-ui/checks.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'factory-ui-check-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.gitignore'), '.issues/\nnode_modules/\n');
  writeFileSync(join(root, 'source.js'), 'export const answer = 42;\n');
  mkdirSync(join(root, '.agents/skills/issues/scripts'), { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json']) {
    cpSync(resolve('.agents/skills/issues/scripts', name), join(root, '.agents/skills/issues/scripts', name));
  }
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | implement |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(root, '.issues/20261022-one.md'),
    '---\nid: 20261022-one\nstate: investigate\ngrill_later: false\n---\n# One issue\n'
  );
  const api = factory(root);
  api.init();
  const proposal = {
    kind: 'investigate',
    title: 'Read source',
    scope: 'One file',
    reason: 'Find the answer',
    verification: 'Read source.js',
    worker_prompt: 'Read source.js only.',
    merge: 'none',
    dependencies: [],
    issues: ['20261022-one'],
  };
  const service = new FactoryUI(root);
  t.after(() => service.close());
  return { root, git, api, proposal, service };
}
async function settle(service, id) {
  for (let n = 0; n < 200; n++) {
    if (!service.store.connected.has(id)) return service.store.runs.find((r) => r.id === id);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Fixture worker did not finish');
}
function transport(t, service) {
  const path = join(service.root, '.issues/cli-fixture.mjs');
  writeFileSync(
    path,
    `import {createInterface} from 'node:readline';
  const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
    if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
    if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'fixture-thread'}}});
    if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId}}});
    if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});
      send({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'agentMessage',text:JSON.stringify(m.params.outputSchema.properties.recommendations?{summary:'One suggestion',recommendations:[{kind:'investigate',title:'Read source',scope:'One file',reason:'Find answer',verification:'Read source',worker_prompt:'Read source.js only',merge:'none',dependencies:[],issues:['20261022-one']}]}:{outcome:'completed',summary:'Read the file.',evidence:'source.js contains 42',remaining:[]})}}});
      send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}});}
  });`
  );
  const cli = new CodexConnection({ command: process.execPath, args: [path], onEvent: (m) => service.store.event(m) });
  service.codex = cli;
  t.after(() => cli.close());
  return cli;
}

test('reading real queue is inert; launch confirmations expire on report changes and cannot replay', async (t) => {
  const { root, api, proposal, service } = fixture(t);
  transport(t, service);
  const [action] = api.recommend([proposal]);
  const before = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  service.snapshot();
  service.snapshot();
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), before);
  assert.equal(existsSync(service.store.directory), false);
  const old = service.preflight(action.id, 'launch');
  writeFileSync(
    join(root, '.issues/20261022-one.md'),
    readFileSync(join(root, '.issues/20261022-one.md'), 'utf8') + 'Changed\n'
  );
  assert.throws(() => service.start(old.token), /changed/);
  const [fresh] = api.recommend([proposal]);
  const selection = service.preflight(fresh.id, 'launch');
  const { runId } = service.start(selection.token);
  assert.throws(() => service.start(selection.token), /expired/);
  const run = await settle(service, runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.threadId, 'fixture-thread');
  assert.equal(api.inspect().registry.actions.find((a) => a.id === fresh.id).status, 'completed');
  assert.equal(service.store.runs.length, 1);

  assert.equal(readFileSync(join(root, 'source.js'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
  assert.equal(existsSync(join(root, '.issues/factory-integration.lock')), false);
});

test('failed worker setup retains one claim and blocks duplicate dispatch', async (t) => {
  const { api, proposal, service } = fixture(t);
  const [a, b] = api.recommend([proposal, proposal]);
  service.codex = new CodexConnection({ command: '/missing-codex-fixture' });
  const { runId } = service.start(service.preflight(a.id, 'launch').token);
  const run = await settle(service, runId);
  assert.equal(run.status, 'blocked');
  assert.equal(api.inspect().registry.actions[0].status, 'blocked');
  assert.throws(() => service.start(service.preflight(b.id, 'launch').token), /already claimed/);
  assert.equal(service.store.runs.length, 1);
});

test('manual integration requires exact candidate approval and never follows worker completion', (t) => {
  const { api, proposal, service, git } = fixture(t);
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'old', hostId: 'native' });
  api.record(action.id, { status: 'completed', worker_revision: git('rev-parse', 'HEAD'), evidence: 'fixture result' });
  assert.equal(service.store.runs.length, 0);
  const selection = service.preflight(action.id, 'integrate');
  assert.equal(selection.requiresApproval, true);
  assert.throws(() => service.start(selection.token, false), /Explicit approval/);
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
  assert.equal(service.store.runs.length, 0);
});

test('Codex approval responses are bound to the pending chat', (t) => {
  const connection = new CodexConnection();
  const sent = [];
  connection.send = (m) => sent.push(m);
  connection.request({
    id: 17,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'one', command: 'fixture' },
  });
  assert.throws(() => connection.answer('17', 'another', { decision: 'allow' }), /no longer pending/);
  connection.answer('17', 'one', { decision: 'decline' });
  assert.deepEqual(sent, [{ id: 17, result: { decision: 'decline' } }]);
  assert.throws(() => connection.answer('17', 'one', { decision: 'allow' }), /no longer pending/);
  connection.request({ id: 18, method: 'unknown/request', params: { threadId: 'one' } });
  assert.equal(sent[1].error.code, -32601);
  t.after(() => connection.close());
});

test('a claimed successful integration cannot bypass independent verification', async (t) => {
  const { root, git, api, proposal, service } = fixture(t);
  transport(t, service);
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(1)"' } }));
  git('add', '.');
  git('commit', '-qm', 'failing independent check');
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'worker', hostId: 'native' });
  api.record(action.id, {
    status: 'completed',
    worker_revision: git('rev-parse', 'HEAD'),
    evidence: 'claimed success',
  });
  const { runId } = service.start(service.preflight(action.id, 'integrate').token, true);
  const run = await settle(service, runId);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /Required check failed/);
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
  assert.equal(existsSync(join(root, '.issues/factory-integration.lock')), true);
  await assert.rejects(
    checkCandidate(root, git('rev-parse', 'HEAD'), join(service.store.directory, run.id)),
    /Required check failed/
  );
});

test('HTTP reads stay inert and cross-origin mutation is refused', async (t) => {
  const { root, service } = fixture(t);
  const server = createFactoryServer(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.equal(page.status, 200);
  assert.equal((await fetch(url + '/api/queue', { headers: { cookie } })).status, 200);
  assert.equal(existsSync(join(root, '.issues/factory-ui-server.lock')), false);
  const options = {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://unrelated.invalid',
      'Content-Type': 'application/json',
      'X-Factory-Action': 'manual',
    },
    body: '{}',
  };
  assert.equal((await fetch(url + '/api/evaluate', options)).status, 400);
  assert.equal(existsSync(service.store.directory), false);
  options.headers.origin = url;
  assert.equal((await fetch(url + '/api/unknown', options)).status, 400);
  assert.equal(existsSync(service.store.directory), false);
});

test('queue review, saving and launching are separate explicit operations', async (t) => {
  const { service, api } = fixture(t);
  transport(t, service);
  const basis = service.snapshot().reviewBasis;
  const { runId } = service.evaluate(basis);
  const run = await settle(service, runId);
  assert.equal(run.status, 'completed');
  assert.equal(api.inspect().registry.actions.length, 0);
  const saved = service.saveReview(runId, basis);
  assert.equal(saved.savedActions.length, 1);
  assert.equal(api.inspect().registry.actions[0].status, 'recommended');
  assert.equal(service.store.runs.length, 1);
  assert.throws(() => service.saveReview(runId, basis), /already been saved/);
});

test('restarting the UI does not replay work; explicit resume keeps the original chat', async (t) => {
  const { root, api, proposal, service } = fixture(t);
  const [action] = api.recommend([proposal]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'fixture-thread', hostId: 'codex-cli' });
  api.record(action.id, { status: 'blocked', evidence: 'Waiting for a human response.' });
  const run = service.store.add(action, 'worker', action.basis.head);
  service.store.update(run, { threadId: 'fixture-thread', checkout: root, status: 'blocked' });
  service.store.connected.delete(run.id);
  const restarted = new FactoryUI(root);
  t.after(() => restarted.close());
  transport(t, restarted);
  assert.equal(restarted.snapshot().runs[0].connected, false);
  assert.equal(restarted.codex.child, undefined);
  await restarted.resume(run.id, 'Continue the same read-only investigation.');
  assert.equal((await settle(restarted, run.id)).status, 'completed');
  assert.equal(restarted.store.runs.length, 1);
  assert.equal(api.inspect().registry.actions[0].threadId, 'fixture-thread');
  assert.throws(() => restarted.answer(run.id, 'unknown', { decision: 'allow' }), /not connected/);
});

test('installed transport client starts and resumes one chat without model overrides', async (t) => {
  const { service, root } = fixture(t);
  const cli = transport(t, service);
  const id = await cli.start(root, 'read-only');
  assert.equal(id, 'fixture-thread');
  const schema = { properties: {} };
  assert.equal(JSON.parse(await cli.turn(id, root, 'Read only', schema)).outcome, 'completed');
  await cli.resume(id, root);
  assert.equal(JSON.parse(await cli.turn(id, root, 'Continue', schema)).outcome, 'completed');
});

test('pending human checks block affected operations without creating a chat', (t) => {
  const { root, api, proposal, service } = fixture(t);
  const path = join(root, '.issues/20261022-one.md');
  writeFileSync(
    path,
    '---\nid: 20261022-one\nstate: investigate\ngrill_later: false\nhuman_checks:\n  - id: device\n    kind: evidence\n    instructions: Check the physical device.\n    status: pending\n    blocks: dependent-work\n    revision: current\n    result: null\n---\nFixture\n'
  );
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  assert.throws(() => service.preflight(action.id, 'launch'), /Human input blocks/);
  assert.equal(service.codex.child, undefined);
  assert.equal(api.inspect().registry.actions[0].status, 'recommended');
});
