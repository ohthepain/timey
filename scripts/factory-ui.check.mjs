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
import { readQueue } from './factory-ui/data.mjs';
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
  const [action] = api.recommend([{ ...proposal, ...options.proposal }]);
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
  configureReviewResult(root, config, options);
  const path = join(root, '.issues/review-cli.mjs');
  writeFileSync(
    path,
    `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';const c=${JSON.stringify(config)};const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;appendFileSync(c.root+'/.issues/rpc.jsonl',JSON.stringify(m)+'\\n');let result;
    if(m.method==='initialize')result={userAgent:'fixture'};
    if(m.method==='thread/list'){const t={id:'original-worker',cwd:c.root,preview:'Factory action '+c.actionId};result={data:c.duplicates?[t,{...t,id:'ambiguous'}]:[t],nextCursor:null};}
    if(m.method==='thread/read')result={thread:{id:'original-worker',cwd:c.root,preview:'Factory action '+c.actionId}};
    if(m.method==='thread/turns/list')result={data:[{id:'original-turn',status:c.status,items:[{type:'agentMessage',text:'Evidence report: '+c.result.evidence[0]}]}]};
    if(m.method==='thread/start')result={thread:{id:'review-coordinator'}};
    if(m.method==='turn/start' && m.params.outputSchema.properties.status){send({id:m.id,result:{turn:{id:'readiness-turn'}}});send({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'agentMessage',text:JSON.stringify({status:'ready',summary:'Nothing blocks this specific next action.'})}}});send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}});return;}
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
function configureReviewResult(root, config, options) {
  config.result.next_state = options.nextState ?? null;
  config.result.skipped_steps = options.skippedSteps ?? [];
  if (options.sourceEvidence) {
    const probe = join(root, '.issues/evidence/probe.py');
    writeFileSync(probe, 'print("fixture evidence")\n');
    config.result.evidence.push(join(root, 'source.js'), probe);
  }
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

async function checkNow(service, state = 'investigate') {
  return settle(service, service.checkReadiness('20261022-one', state).runId);
}
function saveRouteFixture(service, root, steps) {
  service.ownServer();
  const run = service.store.add({ id: 'queue-review' }, 'evaluation', readQueue(root).head);
  const reviewBasis = service.snapshot().reviewBasis;
  service.store.update(run, {
    status: 'completed',
    reviewBasis,
    result: { summary: 'Planned route', recommendations: [], routes: [{ issueId: '20261022-one', steps }] },
  });
  service.store.connected.delete(run.id);
  service.saveReview(run.id, reviewBasis);
  return run;
}

test('readiness is explicit and inert: no chat or assignment when only planning is needed', async (t) => {
  const { root, service, api } = fixture(t);
  const before = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  assert.equal(service.snapshot().issues[0].readiness.status, 'unchecked');
  assert.equal(service.codex.child, undefined);
  const result = await checkNow(service);
  assert.equal(result.readiness.status, 'ready');
  assert.equal(service.snapshot().issues[0].stageStates.investigate.status, 'ready');
  assert.equal(service.codex.child, undefined);
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), before);
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
});

test('readiness reviews the original worker without repeating its assignment; report and code changes expire it', async (t) => {
  const { root, service, api } = pendingReview(t);
  const result = await checkNow(service);
  assert.equal(result.readiness.status, 'ready', result.summary);
  assert.equal(reviewCalls(root).filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(reviewCalls(root).find((call) => call.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(
    reviewCalls(root).some((call) => call.method === 'thread/resume'),
    false
  );
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
  assert.equal(service.snapshot().issues[0].readiness.status, 'ready');
  writeFileSync(join(root, 'source.js'), 'export const answer = 43;\n');
  assert.equal(service.snapshot().issues[0].readiness.status, 'unchecked');
  await checkNow(service);
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nNew scope\n');
  assert.equal(service.snapshot().issues[0].readiness.expired, true);
});

test('ambiguous worker identity is a concrete red blocker, not permission to launch again', async (t) => {
  const { root, service, api } = pendingReview(t, { duplicates: true });
  const result = await checkNow(service);
  assert.equal(result.readiness.status, 'blocked');
  assert.match(result.summary, /Find existing chat/);
  assert.equal(service.snapshot().issues[0].stageStates.investigate.status, 'blocked');
  assert.equal(
    reviewCalls(root).some((call) => call.method === 'thread/start'),
    false
  );
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
});

test('native worker activity is green working; a stopped worker is blocked', async (t) => {
  const active = pendingReview(t, { status: 'inProgress' });
  assert.equal((await checkNow(active.service)).readiness.status, 'working');
  assert.equal(active.service.snapshot().issues[0].stageStates.investigate.status, 'working');
  const stopped = pendingReview(t, { status: 'interrupted' });
  assert.equal((await checkNow(stopped.service)).readiness.status, 'blocked');
});

test('routes save separately from execution, survive restart, and do not invent earlier outcomes', (t) => {
  const { root, service, api } = pendingReview(t);
  prototypePath(root);
  saveRouteFixture(service, root, [
    { state: 'implement', decision: 'take', reason: 'A fix is needed.' },
    { state: 'experiment', decision: 'skip', reason: 'The approach is agreed.' },
  ]);
  const restarted = new FactoryUI(root);
  t.after(() => restarted.close());
  const issue = restarted.snapshot().issues[0];
  assert.equal(issue.stageStates.implement.label, 'Planned');
  assert.equal(issue.stageStates.experiment.status, 'planned-skip');
  assert.equal(issue.stageStates.final.label, 'Not decided');
  assert.equal(api.inspect().registry.actions.length, 1);
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
  assert.equal(api.inspect().reports[0].metadata.lifecycle_history, undefined);
});

test('invalid routes are rejected before saving any assignments', (t) => {
  const { root, service, api } = pendingReview(t);
  assert.throws(
    () => saveRouteFixture(service, root, [{ state: 'closed', decision: 'skip', reason: 'No acceptance' }]),
    /cannot skip explicit acceptance/
  );
  assert.equal(api.inspect().registry.actions.length, 1);
});

test('reviewed advancement records a completed stage, not an entire assumed history', async (t) => {
  const { service, api } = pendingReview(t, { nextState: 'implement' });
  assert.equal((await reviewNow(service)).status, 'completed');
  const history = api.inspect().reports[0].metadata.lifecycle_history;
  assert.equal(history.length, 1);
  assert.equal(history[0].state, 'investigate');
  assert.equal(history[0].outcome, 'completed');
  assert.ok(history[0].evidence.length);
  assert.equal(service.snapshot().issues[0].stageStates.investigate.status, 'completed');
});

function prototypePath(root) {
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | experiment |\n| ready-to-prototype | experiment | implement |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
}
test('a reviewed optional skip follows a saved plan, records both outcomes and preserves acceptance', async (t) => {
  const { root, service, api } = pendingReview(t, {
    nextState: 'implement',
    skippedSteps: [{ state: 'experiment', reason: 'The approach is already agreed.' }],
  });
  prototypePath(root);
  saveRouteFixture(service, root, [{ state: 'experiment', decision: 'skip', reason: 'No design experiment needed.' }]);
  assert.equal(service.snapshot().issues[0].stageStates.experiment.status, 'planned-skip');
  const result = await reviewNow(service);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(api.inspect().reports[0].metadata.state, 'implement');
  assert.deepEqual(
    api.inspect().reports[0].metadata.lifecycle_history.map((e) => e.outcome),
    ['completed', 'skipped']
  );
  assert.equal(service.snapshot().issues[0].stageStates.experiment.status, 'skipped');
});
test('a planned skip cannot bypass required verification', async (t) => {
  const { root, service, api } = pendingReview(t, {
    nextState: 'final',
    skippedSteps: [
      { state: 'implement', reason: 'No work needed.' },
      { state: 'verify', reason: 'Skip tests.' },
    ],
  });
  const steps = [
    { state: 'implement', decision: 'skip', reason: 'Proposed skip.' },
    { state: 'verify', decision: 'skip', reason: 'Proposed skip.' },
  ];
  assert.throws(() => saveRouteFixture(service, root, steps), /required by project policy/);
  const old = service.store.add({ id: 'old-plan' }, 'evaluation', readQueue(root).head);
  service.store.update(old, { status: 'completed', savedRoutes: [{ issueId: '20261022-one', steps }] });
  service.store.connected.delete(old.id);
  const result = await reviewNow(service);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /required by project policy/);
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
  assert.equal(api.inspect().reports[0].metadata.lifecycle_history, undefined);
});

function checkReport(blocks) {
  return (
    '---\nid: 20261022-one\nstate: investigate\ngrill_later: false\nhuman_checks:\n  - id: required-check\n    kind: judgment\n    instructions: Review the work.\n    status: pending\n    blocks: ' +
    blocks +
    '\n    revision: current\n    result: null\n---\nOriginal report\n'
  );
}
test('readiness distinguishes final-only human judgment from input required by the current action', async (t) => {
  const finalOnly = pendingReview(t, { report: checkReport('closure') });
  assert.equal((await checkNow(finalOnly.service)).readiness.status, 'ready');
  const blocked = pendingReview(t, {
    report: checkReport('dependent-work').replace('state: investigate', 'state: verify'),
    proposal: { kind: 'verify' },
  });
  const result = await checkNow(blocked.service, 'verify');
  assert.equal(result.readiness.status, 'blocked');
  assert.match(result.summary, /An answer or manual check required for this action/);
  assert.equal(existsSync(join(blocked.root, '.issues/rpc.jsonl')), false);
});
test('an old blocked review does not mark a later stage blocked', async (t) => {
  const { root, service } = pendingReview(t, { duplicates: true });
  await reviewNow(service);
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8').replace('state: investigate', 'state: implement'));
  const current = service.snapshot().issues[0];
  assert.equal(current.readiness.status, 'unchecked');
  assert.equal(current.stageStates.investigate.status, 'unknown');
});

test('integration approval is shown as a current requirement; checking never integrates or creates a chat', async (t) => {
  const { service, api, proposal, git } = fixture(t);
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'existing-worker', hostId: 'local' });
  api.record(action.id, {
    status: 'completed',
    worker_revision: git('rev-parse', 'HEAD'),
    evidence: 'Fixture code candidate',
  });
  const result = await checkNow(service);
  assert.equal(result.readiness.status, 'blocked');
  assert.equal(result.readiness.approvalAvailable, true);
  assert.equal(service.codex.child, undefined);
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
});

test('finished issue review is shown and cannot repeat against unchanged input', (t) => {
  const { service, root } = fixture(t);
  service.ownServer();
  const basis = service.snapshot().reviewBasis;
  const run = service.store.add({ id: 'queue-review' }, 'evaluation', readQueue(root).head);
  service.store.update(run, {
    issueId: '20261022-one',
    issueState: 'investigate',
    reviewBasis: basis,
    status: 'completed',
    summary: 'The repair already exists. Update the issue record; no new worker is needed.',
    result: {
      summary: 'The repair already exists. Update the issue record; no new worker is needed.',
      recommendations: [],
      routes: [],
    },
  });
  service.store.connected.delete(run.id);
  const issue = service.snapshot().issues[0];
  assert.equal(issue.progress.kind, 'reconcile', 'Progress must record existing work rather than repeat planning.');
  assert.equal(issue.latestResult.runId, run.id);
  assert.match(issue.latestResult.summary, /repair already exists/);
  assert.equal(service.progressPreflight('20261022-one', 'investigate').choice.kind, 'reconcile');
});

async function evaluatedIssue(t, result) {
  const context = fixture(t),
    { service } = context;
  const calls = [];
  service.codex = {
    requests: new Map(),
    start: async (...args) => {
      calls.push(args);
      return 'existing-review-chat';
    },
    turn: async () => JSON.stringify(result),
    close() {},
  };
  const started = service.evaluate(service.snapshot().reviewBasis, '20261022-one');
  const run = await settle(service, started.runId);
  assert.equal(run.status, 'completed', run.summary);
  return { ...context, run, calls };
}
test('Progress saves a valid review once, then offers its actual worker launch instead of repeating evaluation', async (t) => {
  const proposal = {
    kind: 'investigate',
    title: 'Read the source',
    scope: 'Read source only',
    reason: 'Find the answer',
    verification: 'Read source.js',
    worker_prompt: 'Read source.js only',
    merge: 'none',
    issues: ['20261022-one'],
    dependencies: [],
  };
  const { service, api, calls } = await evaluatedIssue(t, {
    summary: 'Inspect the source next.',
    next_step: 'Save this investigation, then explicitly start its worker.',
    recommendations: [proposal],
    routes: [],
  });
  assert.equal(service.snapshot().issues[0].progress.kind, 'save-review');
  const confirm = service.progressPreflight('20261022-one', 'investigate');
  service.progressStart(confirm.token);
  assert.throws(() => service.progressStart(confirm.token), /expired/);
  assert.equal(api.inspect().registry.actions.length, 1);
  assert.equal(api.inspect().registry.actions[0].status, 'recommended');
  assert.equal(service.snapshot().issues[0].progress.kind, 'launch');
  assert.equal(service.snapshot().issues[0].latestResult.saved, true);
  assert.equal(service.snapshot().issues[0].latestResult.fresh, true);
  assert.match(service.snapshot().issues[0].latestResult.nextStep, /plan is saved.*start its worker/);
  assert.equal(calls.length, 1);
});
test('a no-worker review offers evidence reconciliation despite an invalid old route', async (t) => {
  const { service, api } = await evaluatedIssue(t, {
    summary: 'Repair exists.',
    recommendations: [],
    routes: [
      { issueId: '20261022-one', steps: [{ state: 'closed', decision: 'skip', reason: 'Bad old suggestion.' }] },
    ],
  });
  assert.equal(service.snapshot().issues[0].progress.kind, 'reconcile');
  assert.equal(service.snapshot().issues[0].latestResult.saveProblem, null);
  assert.equal(api.inspect().registry.actions.length, 0);
});
test('finishing an evaluation invalidates readiness and exposes its next-step instruction', async (t) => {
  const { service, run } = await evaluatedIssue(t, {
    summary: 'An existing repair needs its issue record updated.',
    next_step: 'Review the existing repair and update the issue record in this chat.',
    recommendations: [],
    routes: [],
  });
  const view = service.snapshot().issues[0];
  assert.equal(view.latestResult.runId, run.id);
  assert.match(view.latestResult.nextStep, /update this issue/);
  assert.equal(view.readiness.status, 'ready');
  assert.equal(view.stageStates.investigate.status, 'ready');
});

test('a proposed skip never closes the issue through reconciliation', async (t) => {
  const { service, root } = await evaluatedIssue(t, { summary: 'Repair exists.', recommendations: [], routes: [] });
  service.codex.turn = async () =>
    JSON.stringify({
      outcome: 'completed',
      summary: 'Close it',
      notes: 'Not accepted',
      evidence: [join(root, 'source.js')],
      remaining: [],
      next_state: 'closed',
      skipped_steps: [],
      stage_records: [{ state: 'investigate', outcome: 'completed', reason: 'Read source' }],
      commit_revision: null,
      verification_summary: null,
      audit_summary: null,
    });
  const run = await settle(
    service,
    service.progressStart(service.progressPreflight('20261022-one', 'investigate').token).runId
  );
  assert.equal(run.status, 'blocked');
  assert.equal(service.snapshot().issues[0].state, 'investigate');
});

function completedWorkFixture(t) {
  const context = fixture(t),
    { root, git, service } = context;
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | prototype |\n| ready-to-prototype | prototype | implement |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":true}');
  const log = join(root, '.issues/fallow.log');
  writeFileSync(
    log,
    JSON.stringify({
      kind: 'audit',
      schema_version: 13,
      version: '3.35.0',
      verdict: 'pass',
      attribution: { gate: 'all' },
      summary: { dead_code_issues: 0, complexity_findings: 0, duplication_clone_groups: 0 },
      dead_code: { workspace_diagnostics: [] },
    }) + '\n'
  );
  const summaries = ['verification', 'step'].map((checkpoint) => {
    const path = join(root, '.issues', checkpoint + '.json');
    const checks = (checkpoint === 'step' ? ['fallow'] : ['fallow', 'factory', 'typecheck', 'tests', 'build']).map(
      (name) => ({ name, passed: true, exit: 0, log })
    );
    writeFileSync(
      path,
      JSON.stringify({
        checkpoint,
        base: git('rev-parse', 'HEAD'),
        snapshot_tree: git('rev-parse', 'HEAD^{tree}'),
        passed: true,
        changed_files: [],
        checks,
      })
    );
    return path;
  });
  const result = {
    outcome: 'completed',
    summary: 'The repair is finished. Only your acceptance remains.',
    notes: 'Reviewed existing implementation and checks. No work repeated.',
    remaining: ['Review and accept the compiler repair.'],
    evidence: [join(root, 'source.js'), log, ...summaries],
    next_state: 'final',
    skipped_steps: [],
    commit_revision: git('rev-parse', 'HEAD'),
    verification_summary: summaries[0],
    audit_summary: summaries[1],
    stage_records: [
      { state: 'investigate', outcome: 'completed', reason: 'Cause established.' },
      { state: 'prototype', outcome: 'skipped', reason: 'No design experiment needed.' },
      ...['implement', 'verify', 'commit', '@integration'].map((state) => ({
        state,
        outcome: 'completed',
        reason: 'Existing checked commit is in the target history.',
      })),
    ],
  };
  service.ownServer();
  const old = service.store.add({ id: 'queue-review' }, 'evaluation', git('rev-parse', 'HEAD'));
  service.store.update(old, {
    status: 'completed',
    issueId: '20261022-one',
    issueState: 'investigate',
    result: { recommendations: [], routes: [] },
    summary: 'Existing work.',
  });
  service.store.connected.delete(old.id);
  service.codex = {
    requests: new Map(),
    start: async () => 'review-existing-work',
    turn: async () => JSON.stringify(result),
    close() {},
  };
  return { ...context, result };
}
async function reconcileNow(service) {
  return settle(service, service.progressStart(service.progressPreflight('20261022-one', 'investigate').token).runId);
}
test('Progress records already completed steps together, skips only the optional experiment, and stops at acceptance', async (t) => {
  const { service, api, root } = completedWorkFixture(t);
  const ledger = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  const run = await reconcileNow(service);
  assert.equal(run.status, 'completed', run.summary);
  const issue = service.snapshot().issues[0];
  assert.equal(issue.state, 'final');
  assert.equal(issue.stageStates.implement.status, 'completed');
  assert.equal(issue.stageStates.prototype.status, 'skipped');
  assert.equal(issue.stageStates['@integration'].status, 'completed');
  assert.match(issue.progress.summary, /accept/);
  assert.equal(issue.progress.disabled, true);
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), ledger);
  assert.equal(api.inspect().registry.actions.length, 0);
  assert.match(issue.content, /# One issue/);
});
test('missing current verification prevents false completion and disables an unchanged repeat', async (t) => {
  const { service, result } = completedWorkFixture(t);
  const summary = JSON.parse(readFileSync(result.verification_summary, 'utf8'));
  writeFileSync(result.verification_summary, JSON.stringify({ ...summary, snapshot_tree: '0'.repeat(40) }));
  const run = await reconcileNow(service);
  assert.equal(run.status, 'blocked');
  assert.match(run.summary, /exact candidate tree/);
  assert.equal(service.snapshot().issues[0].state, 'investigate');
  assert.equal(service.snapshot().issues[0].progress.disabled, true);
});
test('reconciliation preserves human requirements and rejects a report changed during review', async (t) => {
  const { service, root, result } = completedWorkFixture(t);
  service.codex.turn = async () => {
    const path = join(root, '.issues/20261022-one.md');
    writeFileSync(path, readFileSync(path, 'utf8') + '\nConcurrent note\n');
    return JSON.stringify(result);
  };
  assert.equal((await reconcileNow(service)).status, 'blocked');
  assert.match(readFileSync(join(root, '.issues/20261022-one.md'), 'utf8'), /Concurrent note/);
  assert.equal(service.snapshot().issues[0].state, 'investigate');
});

test('one Progress action continues from a no-worker recommendation through existing-work bookkeeping', async (t) => {
  const { service, result, root } = completedWorkFixture(t);
  service.store.runs = [];
  service.store.save();
  let turns = 0;
  service.codex.turn = async () =>
    JSON.stringify(
      ++turns === 1
        ? {
            summary: 'Existing repair needs recording.',
            next_step: 'Record existing work.',
            recommendations: [],
            routes: [],
          }
        : result
    );
  const first = await reconcileNow(service);
  assert.equal(first.kind, 'evaluation');
  const update = service.store.runs.find((r) => r.kind === 'reconciliation');
  assert.ok(update, 'Progress should continue without handing routine bookkeeping to the user');
  const finished = await settle(service, update.id);
  assert.equal(finished.status, 'completed', finished.summary);
  assert.equal(service.snapshot().issues[0].state, 'final');
  assert.equal(turns, 2);
  assert.equal(existsSync(join(root, '.issues/factory-progress.lock')), false);
});
test('an unresolved human requirement prevents recording dependent completed work', async (t) => {
  const { service, root } = completedWorkFixture(t);
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, checkReport('dependent-work'));
  const stopped = await reconcileNow(service);
  const unchanged = service.snapshot().issues[0];
  assert.equal(unchanged.lifecycle_history, undefined);
  assert.equal(unchanged.state, 'investigate');
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.summary, /Human input blocks/);
});

test('correcting a result reuses its existing review chat with read-only access', async (t) => {
  const { service, root, result } = completedWorkFixture(t);
  service.codex.turn = async () =>
    JSON.stringify({ ...result, outcome: 'blocked', summary: 'Waiting for retained evidence.' });
  const first = await reconcileNow(service);
  assert.equal(first.status, 'blocked');
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nEvidence is now available.\n');
  let resumed = false;
  service.codex.resume = async (...args) => {
    assert.deepEqual(args, ['review-existing-work', service.root, 'read-only']);
    resumed = true;
  };
  service.codex.turn = async () => JSON.stringify(result);
  service.codex.start = async () => {
    throw Error('Do not create another chat');
  };
  const next = await reconcileNow(service);
  assert.equal(next.status, 'completed', next.summary);
  assert.equal(resumed, true);
  assert.equal(next.threadId, first.threadId);
});

test('a malformed evidence reference is corrected once in the same chat before any issue update', async (t) => {
  const { service, result } = completedWorkFixture(t);
  let turns = 0;
  service.codex.turn = async () =>
    JSON.stringify(++turns === 1 ? { ...result, evidence: ['not-an-absolute-file'] } : result);
  const run = await reconcileNow(service);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(turns, 2);
  assert.deepEqual(run.rejectedResult.evidence, ['not-an-absolute-file']);
  assert.equal(service.snapshot().issues[0].state, 'final');
});

test('final-review buttons close with explicit acceptance and reopen without launching or losing history', async (t) => {
  const { service, api, root } = completedWorkFixture(t);
  assert.equal((await reconcileNow(service)).status, 'completed');
  const before = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  const snapshot = service.snapshot();
  assert.deepEqual(service.decideIssue('20261022-one', 'final', 'close', snapshot.reviewBasis), { state: 'closed' });
  assert.throws(
    () => service.decideIssue('20261022-one', 'final', 'close', snapshot.reviewBasis),
    /another stage|out of date/
  );
  const closed = service.snapshot();
  assert.match(closed.issues[0].content, /user selected Close issue/);
  assert.equal(closed.issues[0].state, 'closed');
  assert.deepEqual(
    service.decideIssue('20261022-one', 'closed', 'reopen', closed.reviewBasis, 'Still fails for my file.'),
    { state: 'investigate' }
  );
  const reopened = service.snapshot().issues[0];
  assert.match(reopened.content, /Still fails for my file/);
  assert.match(reopened.content, /Existing checked commit/);
  assert.equal(reopened.stageStates.implement.status, 'future');
  assert.equal(reopened.progress.kind, 'plan', 'Reopening needs a new review, not the old no-worker conclusion.');
  assert.equal(api.inspect().registry.actions.length, 0);
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), before);
});
test('closing refuses stale source, changed evidence and outstanding manual checks', async (t) => {
  const { service, root, git } = completedWorkFixture(t);
  await reconcileNow(service);
  const snapshot = service.snapshot();
  writeFileSync(join(root, 'source.js'), 'export const answer=99;\n');
  assert.throws(() => service.decideIssue('20261022-one', 'final', 'close', snapshot.reviewBasis), /out of date/);
  git('checkout', '--', 'source.js');
  const report = join(root, '.issues/20261022-one.md');
  const original = readFileSync(report, 'utf8');
  writeFileSync(
    report,
    original.replace(
      'state: final',
      'state: final\nhuman_checks:\n  - id: manual\n    kind: judgment\n    status: pending\n    instructions: Check the result\n    blocks: closure\n    revision: current\n    result: null'
    )
  );
  assert.throws(
    () => service.decideIssue('20261022-one', 'final', 'close', service.snapshot().reviewBasis),
    /manual check/
  );
  writeFileSync(report, original);
  const log = join(root, '.issues/fallow.log');
  writeFileSync(log, readFileSync(log, 'utf8') + 'Changed\n');
  assert.throws(
    () => service.decideIssue('20261022-one', 'final', 'close', service.snapshot().reviewBasis),
    /recorded result changed/
  );
  assert.equal(service.snapshot().issues[0].state, 'final');
});

test('a retained original-worker reference survives follow-up chats that mention the assignment', async (t) => {
  const { service, root, api } = pendingReview(t, { duplicates: true });
  const action = api.inspect().registry.actions[0];
  const old = service.store.add(action, 'coordinator', readQueue(root).head);
  service.store.update(old, { status: 'blocked', workerThreadId: 'original-worker' });
  service.store.connected.delete(old.id);
  const result = await service.findConnection('20261022-one', 'investigate', service.snapshot().reviewBasis);
  assert.equal(result.connected, true);
  assert.equal(api.inspect().registry.actions[0].threadId, 'original-worker');
  assert.equal(service.snapshot().issues[0].readiness.status, 'ready');
  assert.equal(
    reviewCalls(root).some((c) => c.method === 'thread/start'),
    false
  );
});
test('multiple actual workers require a choice; a wrong task chat cannot replace the connection', async (t) => {
  const { service, api, root } = pendingReview(t, { duplicates: true });
  const basis = service.snapshot().reviewBasis;
  const found = await service.findConnection('20261022-one', 'investigate', basis);
  assert.equal(found.connected, false);
  assert.equal(found.candidates.length, 2);
  assert.equal(api.inspect().registry.actions[0].threadId, undefined);
  const originalCall = service.codex.call.bind(service.codex);
  service.codex.call = async (method, args) =>
    method === 'thread/read'
      ? { thread: { id: args.threadId, cwd: root, preview: 'Unrelated work' } }
      : originalCall(method, args);
  await assert.rejects(service.connectWorker('20261022-one', 'investigate', basis, 'wrong-chat'), /did not start with/);
  assert.equal(api.inspect().registry.actions[0].threadId, undefined);
});

test('connecting an unfinished chat does not offer a ready result review', async (t) => {
  const { service, api } = pendingReview(t, { status: 'inProgress' });
  const found = await service.findConnection('20261022-one', 'investigate', service.snapshot().reviewBasis);
  assert.equal(found.connected, true);
  assert.equal(api.inspect().registry.actions[0].threadId, 'original-worker');
  assert.equal(service.store.runs.at(-1).workerPending, true);
  assert.equal(service.snapshot().issues[0].readiness.status, 'unchecked');
});
