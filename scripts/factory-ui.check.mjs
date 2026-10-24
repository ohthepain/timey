import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function pendingReview(t, options = {}) {
  const context = fixture(t),
    { root, api, proposal, service } = context;
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | implement |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  if (options.report) writeFileSync(join(root, '.issues/20261022-one.md'), options.report);
  const [action] = api.recommend([proposal]);
  api.reserve(action.id);
  api.attach(action.id, { clientThreadId: 'original-pending-chat' });
  mkdirSync(join(root, '.issues/evidence'));
  const evidence = join(root, '.issues/evidence/reviewed-log.json');
  writeFileSync(evidence, JSON.stringify({ fixture: true, exit: 0 }));
  const config = {
    root,
    actionId: action.id,
    status: 'completed',
    duplicates: false,
    result: {
      outcome: 'completed',
      summary: 'Reviewed the existing worker result.',
      notes: 'The saved result covers this assignment. Broader acceptance stays pending.',
      evidence: [evidence],
      remaining: ['Human acceptance'],
      next_state: null,
    },
    ...options,
  };
  config.result.next_state = options.nextState ?? null;
  if (options.sourceEvidence) {
    const probe = join(root, '.issues/evidence/probe.py');
    writeFileSync(probe, 'print("fixture evidence")\n');
    config.result.evidence.push(join(root, 'source.js'), probe);
  }
  const path = join(root, '.issues/review-cli.mjs');
  writeFileSync(
    path,
    `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';const c=${JSON.stringify(config)};const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;appendFileSync(c.root+'/.issues/rpc.jsonl',JSON.stringify(m)+'\\n');let result;
    if(m.method==='initialize')result={userAgent:'fixture'};
    if(m.method==='thread/list'){const t={id:'original-worker',cwd:c.root,preview:'Factory action '+c.actionId};result={data:c.duplicates?[t,{...t,id:'ambiguous'}]:[t],nextCursor:null};}
    if(m.method==='thread/read')result={thread:{id:'original-worker',cwd:c.root}};
    if(m.method==='thread/turns/list')result={data:[{id:'original-turn',status:c.status,items:[{type:'agentMessage',text:'Evidence report: '+c.result.evidence[0]}]}]};
    if(m.method==='thread/start')result={thread:{id:'review-coordinator'}};
    if(m.method==='turn/start'){if(c.changeReport)appendFileSync(c.root+'/.issues/20261022-one.md','\\nConcurrent report edit\\n');send({id:m.id,result:{turn:{id:'review-turn'}}});send({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'agentMessage',text:JSON.stringify(c.result)}}});send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}});return;}
    send({id:m.id,result});});`
  );
  service.codex = new CodexConnection({
    command: process.execPath,
    args: [path],
    onEvent: (m) => service.store.event(m),
  });
  return { ...context, action, evidence };
}
function reviewCalls(root) {
  return readFileSync(join(root, '.issues/rpc.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('Progress reviews an existing finished worker in a distinct read-only chat and records only its outcome', async (t) => {
  const { root, api, service, action } = pendingReview(t);
  assert.equal(service.codex.child, undefined);
  const before = readFileSync(join(root, 'source.js'), 'utf8');
  const selection = service.progressPreflight('20261022-one', 'investigate');
  assert.equal(selection.choice.kind, 'review');
  assert.equal(service.codex.child, undefined);
  const { runId } = service.progressStart(selection.token);
  assert.throws(() => service.progressStart(selection.token), /expired/);
  const run = await settle(service, runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.threadId, 'review-coordinator');
  const saved = api.inspect().registry.actions.find((a) => a.id === action.id);
  assert.equal(saved.status, 'reconciled');
  assert.equal(saved.threadId, 'original-worker');
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
  assert.match(api.inspect().reports[0].content, /Worker result review/);
  assert.equal(readFileSync(join(root, 'source.js'), 'utf8'), before);
  const calls = reviewCalls(root);
  assert.equal(calls.filter((c) => c.method === 'thread/start').length, 1);
  assert.equal(calls.find((c) => c.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(
    calls.some((c) => c.method === 'thread/resume'),
    false
  );
  assert.equal(existsSync(join(root, '.issues/factory-progress.lock')), false);
});

test('Progress refuses another stage, stale confirmations and a second concurrent action', async (t) => {
  const { root, service } = pendingReview(t);
  assert.throws(() => service.progressPreflight('20261022-one', 'implement'), /another stage/);
  const stale = service.progressPreflight('20261022-one', 'investigate');
  const path = join(root, '.issues/20261022-one.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nUpdated scope\n');
  assert.throws(() => service.progressStart(stale.token), /changed/);
  const first = service.progressPreflight('20261022-one', 'investigate'),
    second = service.progressPreflight('20261022-one', 'investigate');
  const { runId } = service.progressStart(first.token);
  assert.throws(() => service.progressStart(second.token), /recommended action changed/);
  assert.equal((await settle(service, runId)).status, 'completed');
  assert.equal(service.store.runs.length, 1);
});

test('checking an unfinished worker starts no replacement worker or coordinator chat', async (t) => {
  const { root, service, api } = pendingReview(t, { status: 'inProgress' });
  const run = await reviewNow(service);
  assert.equal(run.status, 'completed');
  assert.match(run.summary, /not finished/);
  assert.equal(
    reviewCalls(root).some((c) => c.method === 'thread/start'),
    false
  );
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
  assert.equal(service.snapshot().issues[0].progress.disabled, undefined);
});

test('ambiguous existing chats stop Progress without any new chat or queue writes', async (t) => {
  const { root, service, api } = pendingReview(t, { duplicates: true });
  const report = api.inspect().reports[0].content;
  const { runId } = service.progressStart(service.progressPreflight('20261022-one', 'investigate').token);
  assert.equal((await settle(service, runId)).status, 'blocked');
  assert.equal(
    reviewCalls(root).some((c) => c.method === 'thread/start'),
    false
  );
  assertReviewNotApplied(api, report);
});

test('Progress follows only a configured guarded next stage and never closes an issue', async (t) => {
  const { service, api, evidence } = pendingReview(t, { nextState: 'implement' });
  const run = await reviewNow(service);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(api.inspect().reports[0].metadata.state, 'implement');
  assert.ok(existsSync(evidence));
});

test('a review that tries to close the issue records neither completion nor acceptance', async (t) => {
  const { service, api } = pendingReview(t, { nextState: 'closed' });
  const before = api.inspect().reports[0].content;
  const run = await reviewNow(service);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /cannot accept or close/);
  assertReviewNotApplied(api, before);
});

test('Progress launches exactly the selected saved recommendation and integration still needs separate approval', async (t) => {
  const { api, proposal, service, git } = fixture(t);
  transport(t, service);
  const [action] = api.recommend([proposal]);
  const selection = service.progressPreflight('20261022-one', 'investigate');
  assert.equal(selection.choice.actionId, action.id);
  const { runId } = service.progressStart(selection.token);
  assert.equal((await settle(service, runId)).status, 'completed');
  assert.equal(service.store.runs.length, 1);
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
  api.record(action.id, { status: 'reconciled', evidence: 'Investigation reviewed independently.' });
  const [code] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  api.reserve(code.id);
  api.attach(code.id, { threadId: 'code-worker', hostId: 'local' });
  api.record(code.id, {
    status: 'completed',
    worker_revision: git('rev-parse', 'HEAD'),
    evidence: 'Recorded code candidate',
  });
  const integration = service.progressPreflight('20261022-one', 'investigate');
  assert.equal(integration.choice.kind, 'integrate');
  assert.equal(integration.requiresApproval, true);
  assert.throws(() => service.progressStart(integration.token, false), /Explicit approval/);
  assert.equal(api.inspect().registry.actions.find((a) => a.id === code.id).status, 'completed');
  assert.equal(service.store.runs.length, 1);
});

test('a pending human decision blocks the proposed stage advance even when the model reports success', async (t) => {
  const human = {
    version: 1,
    scopes: [{ id: 'main', revision: 1, basis_refs: ['report.md#scope'] }],
    requests: [
      {
        id: 'scope-choice',
        kind: 'decision',
        prompt: 'Choose the scope',
        expected: 'A concrete scope',
        scope: { id: 'main', revision: 1 },
        prerequisites: [],
        blocks: [{ operation: 'advance', scope_ids: ['main'], target_state: 'implement' }],
        status: 'pending',
        events: [],
        outcome: null,
      },
    ],
    overlays: [],
  };
  const report =
    '---\nid: 20261022-one\nstate: investigate\ngrill_later: false\nhuman_input: ' +
    JSON.stringify(human) +
    '\n---\nOriginal report\n';
  const { service, api } = pendingReview(t, { report, nextState: 'implement' });
  const run = await reviewNow(service);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /Human input blocks advance/);
  assertReviewNotApplied(api, report);
});

async function reviewNow(service) {
  const selected = service.progressPreflight('20261022-one', 'investigate');
  return settle(service, service.progressStart(selected.token).runId);
}
function assertReviewNotApplied(api, content) {
  assert.equal(api.inspect().reports[0].content, content);
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
}

test('a report edited during result review is preserved and no stale outcome is recorded', async (t) => {
  const { service, api } = pendingReview(t, { changeReport: true });
  const outcome = await reviewNow(service);
  assert.equal(outcome.status, 'blocked');
  assert.match(outcome.summary, /changed during review/);
  assert.match(api.inspect().reports[0].content, /Concurrent report edit/);
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
});

test('review evidence includes actual source and probe files, not only reports', async (t) => {
  const { service, api } = pendingReview(t, { sourceEvidence: true });
  const run = await reviewNow(service);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.evidence.length, 3);
  assert.match(run.evidence.find((file) => file.path.endsWith('probe.py')).sha256, /^[0-9a-f]{64}$/);
  assert.equal(api.inspect().registry.actions[0].status, 'reconciled');
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
});

test('a failed recording retains the model response and offers an explicit fresh review of the same worker', async (t) => {
  const { service, api, root, evidence } = pendingReview(t);
  const content = readFileSync(evidence);
  rmSync(evidence);
  const first = await reviewNow(service);
  assert.equal(first.status, 'blocked');
  assert.equal(first.result.outcome, 'completed');
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
  assert.equal(service.store.runs.length, 1);
  const retry = service.progressPreflight('20261022-one', 'investigate');
  assert.equal(retry.choice.kind, 'review');
  assert.equal(retry.choice.title, 'Review result again');
  assert.match(retry.choice.summary, /will not repeat/);
  assert.equal(service.store.runs.length, 1);
  writeFileSync(evidence, content);
  const second = await settle(service, service.progressStart(retry.token).runId);
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(second.workerThreadId, first.workerThreadId);
  assert.equal(first.status, 'blocked');
  assert.equal(api.inspect().registry.actions[0].status, 'reconciled');
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
  assert.equal(service.progressPreflight('20261022-one', 'investigate').choice.kind, 'plan');
  assert.equal(reviewCalls(root).filter((call) => call.method === 'thread/start').length, 2);
  assert.equal(
    reviewCalls(root).some((call) => call.method === 'thread/resume'),
    false
  );
});
