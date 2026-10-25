import { approvalOptions } from './factory-ui/approval-options.mjs';
import { workerPrompt, integrationPrompt, workerPermissionGuidance } from './factory-ui/prompts.mjs';
import { digest as digestReport } from './factory-ui/common.mjs';
import { beginReconciliation } from './factory-ui/reconcile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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
  const calls = [];
  const send = cli.send.bind(cli);
  cli.send = (message) => {
    calls.push(message);
    send(message);
  };
  const id = await cli.start(root, 'read-only');
  assert.equal(id, 'fixture-thread');
  const schema = { properties: {} };
  assert.equal(JSON.parse(await cli.turn(id, root, 'Read only', schema)).outcome, 'completed');
  await cli.resume(id, root);
  assert.equal(JSON.parse(await cli.turn(id, root, 'Continue', schema)).outcome, 'completed');
  await cli.start(root);
  await cli.resume(id, root, 'read-only');
  const threads = calls.filter((call) => ['thread/start', 'thread/resume'].includes(call.method));
  assert.deepEqual(
    threads.map((call) => call.params.config),
    [undefined, { 'features.request_permissions_tool': true }, { 'features.request_permissions_tool': true }, undefined]
  );
  for (const call of threads) {
    assert.equal(call.params.approvalPolicy, 'on-request');
    assert.equal(call.params.approvalsReviewer, call.params.sandbox === 'workspace-write' ? 'auto_review' : 'user');
    assert.equal(call.params.model, undefined);
  }
  assert.deepEqual(
    calls.filter((call) => call.method === 'turn/start').map((call) => call.params.approvalsReviewer),
    ['user', 'auto_review']
  );
});

test('worker and integration assignments explain grouped native permissions without granting them', () => {
  const action = { id: 'action', basis: { head: 'base' }, worker_prompt: 'Implement', scope: 'Scoped change' };
  for (const prompt of [workerPrompt(action, []), integrationPrompt(action, {})]) {
    assert.ok(prompt.includes(workerPermissionGuidance));
    assert.match(prompt, /request_permissions/);
    assert.match(prompt, /do not force require_escalated for each script/);
    assert.match(prompt, /Never infer permission from a script extension/);
  }
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
    if(m.method==='thread/list'){const t={id:'original-worker',cwd:c.root,preview:'Factory action '+c.actionId,path:c.transcriptPath};result={data:c.duplicates?[t,{...t,id:'ambiguous'}]:[t],nextCursor:null};}
    if(m.method==='thread/read')result={thread:{id:'original-worker',cwd:c.root,preview:'Factory action '+c.actionId,path:c.transcriptPath}};
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
  assert.equal(retry.choice.title, 'Review finished work');
  assert.match(retry.choice.summary, /existing review/);
  assert.equal(service.store.runs.length, 1);
  writeFileSync(evidence, content);
  const second = await settle(service, service.progressStart(retry.token).runId);
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(second.workerThreadId, first.workerThreadId);
  assert.equal(first.status, 'blocked');
  assert.equal(api.inspect().registry.actions[0].status, 'reconciled');
  assert.equal(api.inspect().reports[0].metadata.state, 'investigate');
  assert.equal(service.progressPreflight('20261022-one', 'investigate').choice.kind, 'plan');
  assert.equal(reviewCalls(root).filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(reviewCalls(root).filter((call) => call.method === 'thread/resume').length, 1);
  assert.equal(second.threadId, first.threadId);
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
  finishCodeFixture(api, action.id, git('rev-parse', 'HEAD'), 'Fixture code candidate');
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
  const queue = readQueue(service.root);
  return settle(service, beginReconciliation(service, queue, queue.issues[0]).runId);
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
  const first = await reviewNow(service);
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

test('a successful readiness check stays ready as time passes, while source changes still invalidate it', async (t) => {
  const { service, root } = pendingReview(t);
  const check = await checkNow(service);
  assert.equal(check.readiness.status, 'ready');
  check.updated = new Date(Date.now() - 3600000).toISOString();
  service.store.save();
  assert.equal(service.snapshot().issues[0].readiness.status, 'ready');
  writeFileSync(join(root, 'source.js'), 'export const answer=44;\n');
  assert.equal(service.snapshot().issues[0].readiness.status, 'unchecked');
});
test('the plan viewer reads actual project plans without changing issue records', (t) => {
  const { service, root } = fixture(t);
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(join(root, 'docs/plans/example.md'), '# Project plan\n\n### 5. Review\nRead the result.\n');
  const before = readFileSync(join(root, '.issues/20261022-one.md'), 'utf8');
  assert.match(service.readPlan('docs/plans/example.md').content, /5. Review/);
  writeFileSync(join(root, 'outside.md'), 'Outside plans');
  assert.throws(() => service.readPlan('docs/plans/../../outside.md'), /inside this project/);
  symlinkSync(join(root, 'outside.md'), join(root, 'docs/plans/link.md'));
  assert.throws(() => service.readPlan('docs/plans/link.md'), /inside this project/);
  assert.equal(readFileSync(join(root, '.issues/20261022-one.md'), 'utf8'), before);
});

function implementationFixture(t) {
  const setup = fixture(t),
    { root, git, service } = setup;
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(
    join(root, 'docs/plans/feature-implementation.md'),
    '# Feature\n\n## First version\n\n### 1. Keep outputs separate\n\nAcceptance: Each run uses its own output folder.\n\n### 2. Check cleanup\n\nAcceptance: Temporary files are removed after failure.\n\n## Second version\n\n### 3. Support parallel work\n\nAcceptance: Two independent runs can finish together.\n'
  );
  git('add', '.');
  git('commit', '-qm', 'plan fixture');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-verify | verify | review | Check the work |\n| ready-to-close | review | closed | Human acceptance |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(root, '.issues/20261022-one.md'),
    `---\nid: 20261022-one\nstate: verify\ngrill_later: false\nhuman_checks:\n  - id: experience\n    kind: judgment\n    instructions: Review the delivered experience.\n    status: pending\n    blocks: closure\n    revision: '${git('rev-parse', 'HEAD')}'\n    result: null\n---\n# One issue\n\nPlan: docs/plans/feature-implementation.md\n`
  );
  const sources = [
    'Each run uses its own output folder.',
    'Temporary files are removed after failure.',
    'Two independent runs can finish together.',
  ];
  const result = {
    summary: 'The three planned behaviors have supporting results. Final approval remains separate.',
    steps: sources.map((source, index) => ({
      id: ['line-5', 'line-9', 'line-15'][index],
      name: ['Keep each run’s files separate', 'Clean up after failure', 'Run two jobs at once'][index],
      version: index === 2 ? 'Second version' : 'First version',
      criteria: [
        {
          name: source,
          source,
          status: 'passed',
          explanation: 'The saved output confirms this behavior.',
          next_action: '',
          evidence: [join(root, 'source.js')],
          human_check_id: null,
        },
      ],
    })),
  };
  service.codex = {
    requests: new Map(),
    start: async (_root, mode) => {
      assert.equal(mode, 'read-only');
      return 'checklist-fixture';
    },
    turn: async () => JSON.stringify(result),
    resume: async () => {},
    close() {},
  };
  return { ...setup, result, path: 'docs/plans/feature-implementation.md' };
}
function checkPlan(service, path) {
  const view = service.snapshot();
  return service.checkImplementation('20261022-one', view.issues[0].state, path, view.reviewBasis);
}

test('implementation checklist follows actual plan versions, records evidence and preserves manual boundaries', async (t) => {
  const { service, path, root, api } = implementationFixture(t);
  const registry = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  assert.equal(service.snapshot().issues[0].implementation.record, undefined);
  assert.equal(existsSync(service.store.path), false);
  const { runId } = checkPlan(service, path);
  assert.throws(() => checkPlan(service, path), /running/);
  const run = await settle(service, runId);
  assert.equal(run.status, 'completed', run.summary);
  const issue = service.snapshot().issues[0];
  assert.equal(issue.implementation.fresh, true);
  assert.equal(issue.implementation.canCheck, false);
  assert.deepEqual(
    issue.plan_verification.steps.map((s) => s.version),
    ['First version', 'First version', 'Second version']
  );
  assert.equal(issue.state, 'verify');
  assert.equal(issue.human_checks[0].status, 'pending');
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), registry);
  assert.equal(api.inspect().reports[0].metadata.plan_verification.steps.length, 3);
  assert.throws(() => checkPlan(service, path), /already checked/);
  assert.throws(() => service.readChecklistEvidence(issue.id, '/etc/passwd'), /Choose a supporting file/);
  assert.match(service.readChecklistEvidence(issue.id, join(root, 'source.js')).content, /42/);
});

test('changed evidence, plan, report and source invalidate saved implementation passes', async (t) => {
  const { root, service, path } = implementationFixture(t);
  await settle(service, checkPlan(service, path).runId);
  const evidence = join(root, 'source.js'),
    original = readFileSync(evidence, 'utf8');
  writeFileSync(evidence, original + '// changed\n');
  assert.equal(service.snapshot().issues[0].implementation.fresh, false);
  assert.throws(() => service.readChecklistEvidence('20261022-one', evidence), /changed/);
  writeFileSync(evidence, original);
  assert.equal(service.snapshot().issues[0].implementation.fresh, true);
  const planPath = join(root, path),
    plan = readFileSync(planPath, 'utf8');
  writeFileSync(planPath, plan + '\nNew scope.\n');
  assert.equal(service.snapshot().issues[0].implementation.fresh, false);
  writeFileSync(planPath, plan);
  const reportPath = join(root, '.issues/20261022-one.md');
  writeFileSync(reportPath, readFileSync(reportPath, 'utf8') + '\nNew requirement.\n');
  assert.equal(service.snapshot().issues[0].implementation.fresh, false);
});

test('checklist rejects unsupported passes and missing plan items without changing the issue', async (t) => {
  const { root, service, path, result } = implementationFixture(t);
  const reportPath = join(root, '.issues/20261022-one.md'),
    original = readFileSync(reportPath, 'utf8');
  result.steps[0].criteria[0].evidence = [];
  const rejected = await settle(service, checkPlan(service, path).runId);
  assert.equal(rejected.status, 'blocked');
  assert.match(rejected.summary, /supporting files/);
  assert.equal(readFileSync(reportPath, 'utf8'), original);
  assert.equal(existsSync(join(root, '.issues/factory-progress.lock')), false);
  result.steps.shift();
  const missing = await settle(service, checkPlan(service, path).runId);
  assert.match(missing.summary, /every plan step/);
  assert.equal(readFileSync(reportPath, 'utf8'), original);
});

test('checklist cannot manufacture human approval or use an unrelated plan', async (t) => {
  const { root, service, path, result } = implementationFixture(t);
  writeFileSync(join(root, 'docs/plans/unrelated-implementation.md'), '# Different task');
  const view = service.snapshot();
  assert.throws(
    () =>
      service.checkImplementation('20261022-one', 'verify', 'docs/plans/unrelated-implementation.md', view.reviewBasis),
    /linked to this issue/
  );
  result.steps[0].criteria[0].human_check_id = 'experience';
  const rejected = await settle(service, checkPlan(service, path).runId);
  assert.match(rejected.summary, /cannot approve a human check/);
  assert.equal(service.snapshot().issues[0].human_checks[0].status, 'pending');
});

test('human approval is explicit, only at the needed stage, fresh, and does not close the issue', async (t) => {
  const { root, service, path } = implementationFixture(t);
  await settle(service, checkPlan(service, path).runId);
  let view = service.snapshot();
  assert.throws(
    () => service.decidePlanCheck('20261022-one', 'verify', 'experience', 'passed', view.reviewBasis, 'I reviewed it.'),
    /Final review/
  );
  const reportPath = join(root, '.issues/20261022-one.md');
  writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('state: verify', 'state: review'));
  view = service.snapshot();
  assert.throws(
    () => service.decidePlanCheck('20261022-one', 'review', 'experience', 'passed', view.reviewBasis, 'I reviewed it.'),
    /Check the implementation/
  );
  await settle(service, checkPlan(service, path).runId);
  view = service.snapshot();
  service.decidePlanCheck(
    '20261022-one',
    'review',
    'experience',
    'passed',
    view.reviewBasis,
    'I reviewed the actual result and approve it.'
  );
  const issue = service.snapshot().issues[0];
  assert.equal(issue.human_checks[0].status, 'passed');
  assert.equal(issue.human_checks[0].revision, view.head);
  assert.equal(issue.implementation.fresh, true);
  assert.equal(issue.state, 'review');
  assert.throws(
    () => service.decidePlanCheck('20261022-one', 'review', 'experience', 'failed', view.reviewBasis, 'Old page'),
    /changed/
  );
});

test('an incomplete implementation checklist blocks verification advancement, not only issue closure', async (t) => {
  const { service, path, result } = implementationFixture(t);
  result.steps[1].criteria[0] = {
    ...result.steps[1].criteria[0],
    status: 'not-checked',
    evidence: [],
    explanation: 'No cleanup result was recorded.',
    next_action: 'Run the cleanup failure scenario and save its result.',
  };
  await settle(service, checkPlan(service, path).runId);
  const queue = readQueue(service.root),
    issue = queue.issues[0];
  const { reviewedTransition } = await import('./factory-ui/stage-transition.mjs');
  service.guard = () => [];
  assert.throws(
    () =>
      reviewedTransition(service, queue, issue, { issues: [issue.id] }, { next_state: 'review', skipped_steps: [] }),
    /outstanding implementation checks/
  );
  assert.equal(readQueue(service.root).issues[0].state, 'verify');
});

test('a reviewed issue is kept as an immutable supporting file before checklist bookkeeping changes it', async (t) => {
  const { service, root, path, result } = implementationFixture(t);
  const reportPath = join(root, '.issues/20261022-one.md'),
    original = readFileSync(reportPath, 'utf8');
  result.steps[0].criteria[0].evidence = [reportPath];
  const run = await settle(service, checkPlan(service, path).runId);
  assert.equal(run.status, 'completed', run.summary);
  const issue = service.snapshot().issues[0],
    archive = issue.plan_verification.steps[0].criteria[0].evidence[0];
  assert.notEqual(archive, reportPath);
  assert.equal(service.readChecklistEvidence(issue.id, archive).content, original);
  assert.equal(issue.implementation.fresh, true);
});

function skipInput(service, extra = {}) {
  const view = service.snapshot(),
    issue = view.issues[0];
  return {
    issueId: issue.id,
    state: issue.state,
    basis: view.reviewBasis,
    reason: 'These checks are not needed for this issue.',
    ...extra,
  };
}
function pendingCriterion(criterion) {
  Object.assign(criterion, {
    status: 'not-checked',
    explanation: 'No retained result was found.',
    evidence: [],
    next_action: 'Codex can run this check if it is still needed.',
  });
}

test('a manual skip records the user override without passing the check or changing issue state', async (t) => {
  const { service, path, result } = implementationFixture(t);
  pendingCriterion(result.steps[0].criteria[0]);
  await settle(service, checkPlan(service, path).runId);
  const input = skipInput(service, { stepId: 'line-5', criterionIndex: 0 });
  assert.deepEqual(service.skipPlanChecks(input), { skipped: 1 });
  const issue = service.snapshot().issues[0],
    criterion = issue.plan_verification.steps[0].criteria[0];
  assert.equal(criterion.status, 'skipped');
  assert.equal(criterion.manual_skip.actor, 'human');
  assert.equal(criterion.manual_skip.previous.status, 'not-checked');
  assert.equal(issue.implementation.fresh, true);
  assert.equal(issue.state, 'verify');
  assert.equal(issue.human_checks[0].status, 'pending');
  assert.throws(() => service.skipPlanChecks(input), /changed/);
  const { requireImplementationPasses } = await import('./factory-ui/plan-checks.mjs');
  assert.doesNotThrow(() => requireImplementationPasses(service, readQueue(service.root), issue));
});

test('skip all overrides unfinished ordinary checks, retains passes and leaves human decisions pending', async (t) => {
  const { service, path, result } = implementationFixture(t);
  pendingCriterion(result.steps[0].criteria[0]);
  pendingCriterion(result.steps[2].criteria[0]);
  result.steps[2].criteria[0].human_check_id = 'experience';
  await settle(service, checkPlan(service, path).runId);
  assert.deepEqual(service.skipPlanChecks(skipInput(service, { all: true })), { skipped: 1 });
  const issue = service.snapshot().issues[0];
  assert.deepEqual(
    issue.plan_verification.steps.map((s) => s.criteria[0].status),
    ['skipped', 'passed', 'not-checked']
  );
  assert.equal(issue.human_checks[0].status, 'pending');
  assert.throws(() => service.skipPlanChecks(skipInput(service, { all: true })), /no remaining/);
  assert.throws(
    () => service.skipPlanChecks(skipInput(service, { stepId: 'line-15', criterionIndex: 0 })),
    /human decision/
  );
  const { requireImplementationPasses } = await import('./factory-ui/plan-checks.mjs');
  assert.doesNotThrow(() => requireImplementationPasses(service, readQueue(service.root), issue));
  assert.throws(() => requireImplementationPasses(service, readQueue(service.root), issue, true), /outstanding/);
});

test('user skips survive evidence review but do not carry over to changed source', async (t) => {
  const { root, service, path, result, git } = implementationFixture(t);
  pendingCriterion(result.steps[0].criteria[0]);
  await settle(service, checkPlan(service, path).runId);
  service.skipPlanChecks(skipInput(service, { all: true }));
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nNew supporting information is available.\n');
  await settle(service, checkPlan(service, path).runId);
  assert.equal(service.snapshot().issues[0].plan_verification.steps[0].criteria[0].status, 'skipped');
  writeFileSync(join(root, 'source.js'), 'export const answer = 43;\n');
  git('add', 'source.js');
  git('commit', '-qm', 'changed source');
  await settle(service, checkPlan(service, path).runId);
  assert.equal(service.snapshot().issues[0].plan_verification.steps[0].criteria[0].status, 'not-checked');
});

test('skip rejects blank reasons, stale results, passed items, and concurrent actions', async (t) => {
  const { root, service, path, result } = implementationFixture(t);
  pendingCriterion(result.steps[0].criteria[0]);
  await settle(service, checkPlan(service, path).runId);
  assert.throws(() => service.skipPlanChecks(skipInput(service, { all: true, reason: ' ' })), /short reason/);
  assert.throws(
    () => service.skipPlanChecks(skipInput(service, { stepId: 'line-9', criterionIndex: 0 })),
    /has passed/
  );
  service.store.connected.add('other-action');
  assert.throws(() => service.skipPlanChecks(skipInput(service, { all: true })), /current action/);
  service.store.connected.delete('other-action');
  writeFileSync(join(root, 'source.js'), 'changed\n');
  assert.throws(() => service.skipPlanChecks(skipInput(service, { all: true })), /Refresh the implementation/);
});

async function runReview(service) {
  const preview = service.progressPreflight('20261022-one', 'investigate');
  return settle(service, service.progressStart(preview.token).runId);
}

test('installed shared instructions are captured separately and reject changed links and escaping references', async (t) => {
  const { root } = fixture(t);
  const { captureInstructions } = await import('./factory-ui/review-instructions.mjs');
  const { reviewEvidence } = await import('./factory-ui/review-result.mjs');
  const shared = join(root, '.issues/shared-skill');
  mkdirSync(join(shared, 'references'), { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), '# Shared skill\n');
  writeFileSync(join(shared, 'references/human-input.md'), 'Human decisions stay explicit.\n');
  symlinkSync('/etc/hosts', join(shared, 'references/escape.md'));
  symlinkSync(shared, join(root, '.agents/skills/shared'));
  const directory = join(root, '.issues/recording');
  const inputs = captureInstructions(root, directory);
  assert.equal(inputs.length, 2);
  const path = join(root, '.agents/skills/shared/references/human-input.md');
  const result = {
    outcome: 'completed',
    summary: 'Read actual work and instructions.',
    notes: 'Their roles are separate.',
    remaining: [],
    next_state: null,
    evidence: [join(root, 'source.js'), path],
  };
  const files = reviewEvidence(root, { cwd: root }, result, inputs);
  assert.equal(files[1].kind, 'instruction');
  assert.equal(files[1].source, path);
  assert.equal(readFileSync(files[1].path, 'utf8'), 'Human decisions stay explicit.\n');
  unlinkSync(join(root, '.agents/skills/shared'));
  const other = join(root, '.issues/other-skill');
  mkdirSync(join(other, 'references'), { recursive: true });
  writeFileSync(join(other, 'references/human-input.md'), 'Different instructions.\n');
  symlinkSync(other, join(root, '.agents/skills/shared'));
  assert.throws(() => reviewEvidence(root, { cwd: root }, result, inputs), /instruction link changed/);
});

test('refreshing a historical blocked result resumes its existing review chat without repeating the worker', async (t) => {
  const { root, service, action } = pendingReview(t);
  const old = service.store.add(action, 'coordinator', service.snapshot().head);
  service.store.update(old, {
    issueId: '20261022-one',
    issueState: 'investigate',
    threadId: 'historical-review',
    status: 'blocked',
    summary: 'Could not record an installed instruction.',
  });
  service.store.connected.delete(old.id);
  const result = await runReview(service);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.threadId, 'historical-review');
  const calls = reviewCalls(root);
  assert.equal(calls.filter((c) => c.method === 'thread/start').length, 0);
  assert.equal(calls.find((c) => c.method === 'thread/resume').params.threadId, 'historical-review');
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.ok(result.events.some((e) => e.method === 'item/completed'));
  assert.equal(old.events.length, 0);
});

test('an unchanged completed review retries recording without another model turn', async (t) => {
  const { root, service } = pendingReview(t);
  mkdirSync(join(root, '.issues/factory.lock'));
  const first = await runReview(service);
  assert.equal(first.status, 'blocked');
  assert.ok(first.checkpoint.evidence.length);
  rmSync(join(root, '.issues/factory.lock'), { recursive: true });
  const second = await runReview(service);
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.previousRunId, first.id);
  assert.equal(reviewCalls(root).filter((c) => c.method === 'turn/start').length, 1);
});

test('changed supporting files require a fresh bounded review in the same chat', async (t) => {
  const { root, service, evidence } = pendingReview(t);
  mkdirSync(join(root, '.issues/factory.lock'));
  const first = await runReview(service);
  assert.equal(first.status, 'blocked');
  rmSync(join(root, '.issues/factory.lock'), { recursive: true });
  writeFileSync(evidence, JSON.stringify({ fixture: true, changed: true }));
  const second = await runReview(service);
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(second.threadId, first.threadId);
  const calls = reviewCalls(root);
  assert.equal(calls.filter((c) => c.method === 'thread/start').length, 1);
  assert.equal(calls.filter((c) => c.method === 'thread/resume').length, 1);
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, 2);
});

test('a citation of the known worker transcript is corrected in the same review without requesting file access', async (t) => {
  const { root, service } = pendingReview(t, {
    transcriptPath: '/etc/hosts',
    result: {
      outcome: 'completed',
      summary: 'Selected investigation finished.',
      notes: 'Implementation still remains.',
      evidence: ['/etc/hosts'],
      remaining: ['Implementation'],
      next_state: null,
    },
  });
  const turn = service.codex.turn.bind(service.codex);
  const prompts = [];
  service.codex.turn = async (thread, cwd, prompt, schema) => {
    prompts.push({ thread, prompt });
    if (prompts.length === 1) return turn(thread, cwd, prompt, schema);
    const receipt = service.store.runs.at(-1).workerResultPath;
    assert.ok(receipt);
    const retained = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(retained.threadId, 'original-worker');
    assert.equal(retained.turnId, 'original-turn');
    assert.ok(retained.messages.length);
    return JSON.stringify({
      outcome: 'completed',
      summary: 'Selected investigation finished.',
      notes: 'Implementation still remains.',
      evidence: [receipt, join(root, 'source.js')],
      remaining: ['Implementation'],
      next_state: null,
      skipped_steps: [],
    });
  };
  const run = await runReview(service);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].thread, prompts[1].thread);
  assert.match(prompts[1].prompt, /not an access denial/);
  assert.equal(run.approvedFiles.length, 0);
  assert.ok(!run.fileProblems?.length);
  assert.ok(run.rejectedResult.evidence.includes('/etc/hosts'));
  assert.equal(readQueue(root).issues[0].state, 'investigate');
});

test('a repeated worker-transcript citation stops after one correction without presenting a permission request', async (t) => {
  const { service } = pendingReview(t, {
    transcriptPath: '/etc/hosts',
    result: {
      outcome: 'completed',
      summary: 'Selected work reviewed.',
      notes: 'Need actual supporting reports.',
      evidence: ['/etc/hosts'],
      remaining: [],
      next_state: null,
    },
  });
  const turn = service.codex.turn.bind(service.codex);
  let calls = 0;
  service.codex.turn = (...args) => {
    calls++;
    return turn(...args);
  };
  const run = await runReview(service);
  assert.equal(run.status, 'blocked');
  assert.equal(calls, 2);
  assert.match(run.summary, /no additional file permission is needed/);
  assert.ok(!run.fileProblems?.length);
  assert.equal(run.approvedFiles.length, 0);
});

test('an unrelated external file requires exact consent while retaining the other reviewed files', async (t) => {
  const { root, service } = pendingReview(t, {
    sourceEvidence: true,
    result: {
      outcome: 'completed',
      summary: 'Existing work reviewed.',
      notes: 'A named outside supporting file is cited.',
      evidence: ['/etc/hosts'],
      remaining: [],
      next_state: null,
    },
  });
  const first = await runReview(service);
  assert.equal(first.status, 'blocked');
  assert.equal(first.fileProblems.length, 1);
  assert.equal(first.fileProblems[0].path, '/etc/hosts');
  assert.equal(first.reviewedEvidence.length, 2);
  assert.equal(first.result.outcome, 'completed');
  assert.throws(
    () => service.approveReviewFile({ runId: first.id, path: '/etc/passwd', basis: service.snapshot().reviewBasis }),
    /exact supporting file/
  );
  const next = service.approveReviewFile({
    runId: first.id,
    path: '/etc/hosts',
    basis: service.snapshot().reviewBasis,
  });
  const result = await settle(service, next.runId);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.threadId, first.threadId);
  assert.equal(result.approvedFiles.length, 1);
  assert.equal(result.approvedFiles[0].scope, 'this review');
  assert.ok(result.evidence.some((e) => e.kind === 'supporting-file'));
  assert.equal(reviewCalls(root).filter((c) => c.method === 'thread/start').length, 1);
});

test('an explicitly resumed archived review reopens only its own saved chat', async () => {
  const { resumeReviewThread } = await import('./factory-ui/review-recovery.mjs');
  const calls = [],
    run = {},
    previous = { id: 'prior', threadId: 'saved-review' };
  let archived = true;
  const service = {
    root: '/project',
    store: { update: (_run, value) => Object.assign(run, value) },
    codex: {
      resume: async (id, root, sandbox) => {
        calls.push(['resume', id, root, sandbox]);
        if (archived) throw Error('session saved-review is archived.');
      },
      unarchive: async (id) => {
        calls.push(['unarchive', id]);
        archived = false;
      },
      start: async () => {
        throw Error('Must not create another chat.');
      },
    },
  };
  assert.equal(await resumeReviewThread(service, run, previous), 'saved-review');
  assert.deepEqual(calls, [
    ['resume', 'saved-review', '/project', 'read-only'],
    ['unarchive', 'saved-review'],
    ['resume', 'saved-review', '/project', 'read-only'],
  ]);
  assert.equal(run.previousRunId, 'prior');
});

test('the Codex transport unarchives exactly the selected thread through the supported RPC', async () => {
  const connection = new CodexConnection(),
    calls = [];
  connection.ready = async () => {};
  connection.call = async (method, params) => {
    calls.push({ method, params });
  };
  await connection.unarchive('existing-review');
  assert.deepEqual(calls, [{ method: 'thread/unarchive', params: { threadId: 'existing-review' } }]);
});

test('implementation checklist stays in Verify when the issue advances to Commit', () => {
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const source = html.slice(
    html.indexOf('      function currentStageContent('),
    html.indexOf('      const checkLabels')
  );
  const render = new Function(
    'implementationChecklist',
    'reviewFileProblems',
    'progressControls',
    'latestReviewResult',
    source + ';return currentStageContent;'
  )(
    () => '<checklist>Saved passed and skipped steps</checklist>',
    () => '<file-problems/>',
    () => '<progress/>',
    () => '<result/>'
  );
  const issue = { implementation: { record: { steps: [{ name: 'Saved step' }] } } };
  assert.match(render(issue, { role: 'ready-to-verify' }), /<checklist>/);
  for (const role of ['ready-for-commit', 'integration', 'ready-to-close', 'closed']) {
    assert.doesNotMatch(render(issue, { role }), /<checklist>/, role);
  }
  const extraSource = html.slice(html.indexOf('      function stepExtra('), html.indexOf('      function issueStep('));
  const extra = new Function('implementationChecklist', extraSource + ';return stepExtra;')((issue) =>
    issue.implementation.readOnly ? '<checklist>Saved results</checklist>' : ''
  );
  assert.match(extra({ ...issue, state: 'commit' }, { role: 'ready-to-verify', state: 'verify' }, []), /<checklist>/);
  assert.doesNotMatch(render({ implementation: { record: null } }, { role: 'ready-for-repro' }), /<checklist>/);
  assert.match(render({ implementation: { record: null } }, { role: 'ready-to-verify' }), /<checklist>/);
});

test('earlier checklist results keep their recorded status without enabling actions', () => {
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const source = html.slice(
    html.indexOf('      function implementationCriterion('),
    html.indexOf('      function skippableCriterion(')
  );
  const render = new Function(
    'esc',
    'checkCircle',
    'checkLabels',
    'criterionSkip',
    source + ';return implementationCriterion;'
  )(
    (value) => value,
    (status) => `<circle>${status}</circle>`,
    { passed: 'Passed', skipped: 'Skipped' },
    () => ''
  );
  for (const status of ['passed', 'skipped']) {
    const content = render(
      { implementation: { fresh: false } },
      { name: 'Saved check', status, source: 'Plan', evidence: [] },
      'step',
      0
    );
    assert.ok(content.includes(`<circle>${status}</circle>`));
    assert.match(content, /Earlier result/);
    assert.match(content, /Check again before relying on the earlier result/);
  }
});

test('lifecycle Progress is direct, shows inline questions and disables duplicate clicks during work', () => {
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const source = html.slice(
    html.indexOf('      const lifecycleDrafts ='),
    html.indexOf('      function liveStepWork(')
  );
  const screen = { lifecycle: [], runs: [] };
  const render = new Function('data', 'esc', 'busy', 'approvals', source + ';return lifecyclePanel;')(
    screen,
    (value) => String(value || ''),
    false,
    () => ''
  );
  const issue = { id: 'one', state: 'investigate' };
  assert.match(render(issue), /data-lifecycle-start/);
  assert.doesNotMatch(render(issue), /showModal|readiness|data-progress-id/);
  issue.lifecycle = { status: 'running', summary: 'Reading source', events: [] };
  assert.match(render(issue), /data-lifecycle-start[^>]*disabled/);
  issue.lifecycle = {
    status: 'waiting',
    summary: 'Your input is needed',
    updated: 'now',
    input: { type: 'questions', questions: [{ question: 'Which behavior do you want?' }] },
  };
  assert.match(render(issue), /Which behavior do you want/);
  assert.match(render(issue), /Send answer and continue/);
  assert.doesNotMatch(render(issue), /data-lifecycle-start/);
});

function commitFixture(t) {
  const f = fixture(t);
  const revision = f.git('rev-parse', 'HEAD');
  writeFileSync(
    join(f.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | custom-check |\n| custom | custom-check | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(f.root, '.issues/20261022-one.md'),
    `---\nid: 20261022-one\nstate: commit\ngrill_later: false\nlifecycle_history:\n  - state: verify\n    outcome: completed\n    revision: ${revision}\n    at: 2026-10-24T12:00:00Z\n    reason: Relevant checks passed.\n    evidence: [saved-checks.json]\n---\n# Verified issue\n`
  );
  f.service.guard = () => ({});
  f.service.codex.start = async () => {
    throw Error('Commit must not open a chat');
  };
  return { ...f, revision };
}
test('Commit records the verified existing commit directly without a chat or repeating Verify', async (t) => {
  const { service, api, git, revision } = commitFixture(t);
  assert.equal(service.snapshot().issues[0].progress.kind, 'commit');
  const selected = service.progressPreflight('20261022-one', 'commit');
  const run = await settle(service, service.progressStart(selected.token, false).runId);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(git('rev-parse', 'HEAD'), revision);
  const report = api.inspect().reports[0].metadata;
  assert.equal(report.state, 'custom-check');
  assert.equal(report.lifecycle_history.at(-1).state, 'commit');
  assert.equal(report.lifecycle_history.at(-1).revision, revision);
  assert.equal(service.store.runs.length, 1);
  assert.equal(run.threadId, undefined);
});

async function blockedCommit(service, api) {
  const selected = service.progressPreflight('20261022-one', 'commit');
  const run = await settle(service, service.progressStart(selected.token, false).runId);
  assert.equal(run.status, 'blocked', run.summary);
  assert.equal(api.inspect().reports[0].metadata.state, 'commit');
  assert.equal(run.threadId, undefined);
}
test('Commit preserves uncommitted source instead of staging unrelated changes', async (t) => {
  const { root, service, api } = commitFixture(t);
  writeFileSync(join(root, 'source.js'), 'export const answer = 43;\n');
  await blockedCommit(service, api);
  assert.match(readFileSync(join(root, 'source.js'), 'utf8'), /43/);
});
test('Commit rejects a revision changed since Verify completed', async (t) => {
  const { root, git, service, api } = commitFixture(t);
  writeFileSync(join(root, 'extra.js'), 'export const extra = 1;\n');
  git('add', 'extra.js');
  git('commit', '-qm', 'Different source');
  await blockedCommit(service, api);
});
test('Commit keeps operation-specific required human guards', async (t) => {
  const { service, api } = commitFixture(t);
  service.guard = () => {
    throw Error('Required human answer missing');
  };
  await blockedCommit(service, api);
});

async function finalChecklist(t) {
  const f = implementationFixture(t);
  Object.assign(f.result.steps[0].criteria[0], {
    status: 'not-checked',
    human_check_id: 'experience',
    evidence: [],
    explanation: 'Final judgment is pending.',
    next_action: 'Review the result.',
  });
  const proof = join(f.root, '.issues/acceptance-proof.txt');
  writeFileSync(proof, 'Saved check result.\n');
  f.result.steps[1].criteria[0].evidence = [proof];
  await settle(f.service, checkPlan(f.service, f.path).runId);
  const snapshot = f.service.snapshot(),
    issue = snapshot.issues[0];
  const history = [
    {
      state: 'verify',
      outcome: 'completed',
      next: 'review',
      reason: 'All required automated checks passed.',
      revision: snapshot.head,
      at: new Date().toISOString(),
      evidence: issue.plan_verification.evidence,
    },
  ];
  const report = join(f.root, '.issues/20261022-one.md');
  writeFileSync(
    report,
    readFileSync(report, 'utf8').replace(
      'state: verify',
      'state: review\nlifecycle_history: ' + JSON.stringify(history)
    )
  );
  return f;
}
test('Accept and close records the final checklist judgment and closes after bookkeeping-only changes', async (t) => {
  const { service } = await finalChecklist(t);
  const snapshot = service.snapshot();
  assert.equal(snapshot.issues[0].implementation.fresh, false);
  assert.deepEqual(service.decideIssue('20261022-one', 'review', 'close', snapshot.reviewBasis), { state: 'closed' });
  const issue = service.snapshot().issues[0];
  assert.equal(issue.state, 'closed');
  assert.equal(issue.human_checks[0].status, 'passed');
  assert.equal(issue.human_checks[0].revision, snapshot.head);
  assert.equal(issue.plan_verification.steps[0].criteria[0].status, 'passed');
  assert.match(issue.content, /Accepted and closed by the user/);
});
test('Accept and close cannot invent an observation or approve changed evidence', async (t) => {
  const observation = await finalChecklist(t);
  const report = join(observation.root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8').replace('kind: judgment', 'kind: evidence'));
  assert.throws(
    () =>
      observation.service.decideIssue('20261022-one', 'review', 'close', observation.service.snapshot().reviewBasis),
    /manual check/
  );
  assert.equal(observation.service.snapshot().issues[0].human_checks[0].status, 'pending');
  const changed = await finalChecklist(t);
  writeFileSync(join(changed.root, 'source.js'), 'export const answer = 99;\n');
  assert.throws(
    () => changed.service.decideIssue('20261022-one', 'review', 'close', changed.service.snapshot().reviewBasis),
    /source changes/
  );
  assert.equal(changed.service.snapshot().issues[0].state, 'review');
});
test('confirmation failure is visible inside the dialog and successful actions refresh the screen', async () => {
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const source = html.slice(html.indexOf('      async function act('), html.indexOf('      function actionCard('));
  const elements = { error: {}, 'confirmation-error': {}, approve: {}, confirm: { open: true } };
  let refreshed = 0,
    rendered = 0;
  const act = new Function('$', 'refresh', 'render', 'let busy=false,data={};' + source + ';return act;')(
    (id) => elements[id],
    async () => {
      refreshed++;
    },
    () => {
      rendered++;
    }
  );
  await act(async () => {
    throw Error('An observation is still required.');
  });
  assert.equal(elements['confirmation-error'].textContent, 'An observation is still required.');
  assert.equal(elements.approve.disabled, false);
  await act(async () => {
    elements.confirm.open = false;
  });
  assert.equal(refreshed, 1);
  assert.equal(rendered, 2);
});

test('changed supporting evidence cannot be approved by Accept and close', async (t) => {
  const { service, root } = await finalChecklist(t);
  writeFileSync(join(root, '.issues/acceptance-proof.txt'), 'Changed check result.\n');
  assert.throws(
    () => service.decideIssue('20261022-one', 'review', 'close', service.snapshot().reviewBasis),
    /Supporting evidence changed/
  );
  assert.equal(service.snapshot().issues[0].state, 'review');
  assert.equal(service.snapshot().issues[0].human_checks[0].status, 'pending');
});

test('closing retains a changed administrative task log without changing test outcomes', async (t) => {
  const f = implementationFixture(t);
  f.result.steps[1].criteria[0].evidence = [join(f.root, '.issues/factory.json')];
  Object.assign(f.result.steps[0].criteria[0], {
    status: 'not-checked',
    human_check_id: 'experience',
    evidence: [],
    explanation: 'Final judgment pending.',
    next_action: 'Review result.',
  });
  await settle(f.service, checkPlan(f.service, f.path).runId);
  const snapshot = f.service.snapshot(),
    report = join(f.root, '.issues/20261022-one.md');
  const event = {
    state: 'verify',
    next: 'review',
    outcome: 'completed',
    reason: 'Verified.',
    revision: snapshot.head,
    at: new Date().toISOString(),
    evidence: [
      {
        path: join(f.root, 'source.js'),
        sha256: snapshot.issues[0].plan_verification.evidence.find((e) => e.path.endsWith('source.js')).sha256,
      },
    ],
  };
  writeFileSync(
    report,
    readFileSync(report, 'utf8').replace(
      'state: verify',
      'state: review\nlifecycle_history: ' + JSON.stringify([event])
    )
  );
  const registry = join(f.root, '.issues/factory.json');
  writeFileSync(registry, readFileSync(registry, 'utf8') + '\n');
  assert.deepEqual(f.service.decideIssue('20261022-one', 'review', 'close', f.service.snapshot().reviewBasis), {
    state: 'closed',
  });
  const closed = f.service.snapshot().issues[0];
  const receipt = closed.plan_verification.evidence.find((e) => e.path.endsWith('-task-record.json'));
  assert.ok(receipt);
  assert.ok(JSON.parse(readFileSync(receipt.path, 'utf8')).earlier_sha256);
  assert.equal(closed.plan_verification.steps[1].criteria[0].status, 'passed');
});

test('Close issue submits acceptance in one tap without opening a confirmation dialog', async () => {
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const source = html.slice(
    html.indexOf('      function selectIssueDecision('),
    html.indexOf('      function progressControls(')
  );
  const elements = {
    selection: {},
    approve: {},
    confirm: {
      showModal() {
        throw Error('Close must not open a confirmation');
      },
    },
  };
  const sent = [];
  const errors = new Map();
  let failRequest = false;
  const selectDecision = new Function(
    '$',
    'data',
    'act',
    'request',
    'decisionErrors',
    'let selection;' + source + ';return selectIssueDecision;'
  )(
    (id) => elements[id],
    { reviewBasis: 'current-page' },
    async (task) => task(),
    async (endpoint, body) => {
      if (failRequest) throw Error('The recorded result is missing.');
      sent.push({ endpoint, body });
      return { state: 'closed' };
    },
    errors
  );
  const button = { dataset: { issueDecision: 'close', issueId: 'one', issueState: 'final' } };
  await selectDecision(button);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, 'issue-decision');
  assert.equal(sent[0].body.kind, 'close');
  assert.equal(sent[0].body.basis, 'current-page');
  assert.equal(button.disabled, true);
  failRequest = true;
  await assert.rejects(() => selectDecision(button), /recorded result is missing/);
  assert.equal(errors.get('one'), 'The recorded result is missing.');
  const controls = html.slice(
    html.indexOf('      function finalControls('),
    html.indexOf('      const decisionErrors')
  );
  const render = new Function('humanChecks', 'esc', 'decisionErrors', controls + ';return finalControls;')(
    () => '',
    (value) => value,
    errors
  );
  assert.match(
    render({ id: 'one', state: 'final' }, 'ready-to-close'),
    /role="alert"[^>]*>The recorded result is missing/
  );
});

test('older final-review issue with an integrated commit can be accepted without fabricated stage history', (t) => {
  const { root, git, api, service, proposal } = fixture(t);
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(
    report,
    '---\nid: 20261022-one\nstate: final\ngrill_later: false\n---\n# Integrated fix\n\nThe older coordinator recorded integration and verification here.\n'
  );
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'automatic' }]);
  finishCodeFixture(api, action.id, git('rev-parse', 'HEAD'), 'Existing checked fix.');
  api.record(action.id, {
    status: 'integrated',
    checks_passed: true,
    verified_revision: git('rev-parse', 'HEAD'),
    evidence: 'Integrated and checked before this UI existed.',
  });
  const snapshot = service.snapshot();
  assert.equal(snapshot.issues[0].lifecycle_history, undefined);
  assert.deepEqual(service.decideIssue('20261022-one', 'final', 'close', snapshot.reviewBasis), { state: 'closed' });
  const closed = service.snapshot().issues[0];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.lifecycle_history.length, 1);
  assert.equal(closed.lifecycle_history[0].actor, 'human');
  assert.match(closed.content, /Original verification dates and limitations/);
});

function finishCodeFixture(api, actionId, revision, evidence) {
  api.reserve(actionId);
  api.attach(actionId, { threadId: 'existing-worker', hostId: 'local' });
  api.record(actionId, { status: 'completed', worker_revision: revision, evidence });
}

function recordOnlyFixture(t) {
  const f = fixture(t);
  writeFileSync(
    join(f.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(join(f.root, '.issues/preferences.json'), '{"commit":true}');
  writeFileSync(
    join(f.root, '.issues/20261022-one.md'),
    '---\nid: 20261022-one\nstate: implement\ngrill_later: false\n---\n# Update records\n\nThe corrections already exist. Preserve the unperformed self-healing test as a limitation.\n'
  );
  writeFileSync(
    join(f.root, '.issues/20261022-other.md'),
    '---\nid: 20261022-other\nstate: implement\ngrill_later: false\n---\n# Unrelated issue\n'
  );
  const update = {
    issue_id: '20261022-one',
    summary: 'The existing corrections are now recorded.',
    notes: 'The reports and existing action identities agree with the retained result. No software change is needed.',
    evidence: [join(f.root, 'source.js')],
    remaining: ['The self-healing test was not performed. Final acceptance remains with the user.'],
  };
  return { ...f, update };
}
test('a record-only evaluation finishes the update and stops at Final review without another worker or commit', async (t) => {
  const { root, git, service, update } = recordOnlyFixture(t);
  const registry = readFileSync(join(root, '.issues/factory.json'), 'utf8');
  const other = readFileSync(join(root, '.issues/20261022-other.md'), 'utf8');
  const head = git('rev-parse', 'HEAD');
  let chats = 0;
  service.codex.start = async () => {
    assert.equal(++chats, 1, 'No second chat needed');
    return 'existing-review';
  };
  service.codex.turn = async () =>
    JSON.stringify({
      summary: 'Only the issue record remains to update.',
      recommendations: [],
      routes: [],
      next_step: 'Record existing work.',
      record_update: update,
    });
  const selected = service.progressPreflight('20261022-one', 'implement');
  const run = await settle(service, service.progressStart(selected.token, false).runId);
  assert.equal(run.status, 'completed', run.summary);
  const issue = service.snapshot().issues.find((i) => i.id === '20261022-one');
  assert.equal(issue.state, 'final');
  assert.match(issue.content, /self-healing test was not performed/);
  assert.match(issue.record_update.remaining.join(' '), /self-healing test was not performed/);
  assert.equal(issue.lifecycle_history.find((e) => e.state === 'commit').outcome, 'skipped');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), registry);
  assert.equal(readFileSync(join(root, '.issues/20261022-other.md'), 'utf8'), other);
  assert.equal(chats, 1);
  assert.equal(service.store.runs.filter((r) => r.kind === 'worker').length, 0);
});

test('record-only updates reject a different issue before changing records', (t) => {
  const { root, update } = recordOnlyFixture(t);
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const snapshot = service.snapshot();
  assert.throws(
    () =>
      service.recordUpdate('20261022-one', 'implement', snapshot.reviewBasis, {
        ...update,
        issue_id: '20261022-other',
      }),
    /must belong/
  );
  assert.equal(service.snapshot().issues.find((i) => i.id === '20261022-one').state, 'implement');
  assert.equal(service.store.runs.length, 0);
});
test('record-only completion refuses a required custom stage', async (t) => {
  const { root, service, update } = recordOnlyFixture(t);
  const labels = join(root, '.issues/triage-labels.md');
  writeFileSync(
    labels,
    readFileSync(labels, 'utf8').replace(
      '| ready-for-commit | commit | final |',
      '| ready-for-commit | commit | custom-review |\n| custom | custom-review | final |'
    )
  );
  assert.throws(
    () => service.recordUpdate('20261022-one', 'implement', service.snapshot().reviewBasis, update),
    /custom step/
  );
  assert.equal(service.snapshot().issues.find((i) => i.id === '20261022-one').state, 'implement');
});

function lifecycleFixture(t) {
  const setup = fixture(t),
    { root, git, service } = setup;
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(
    join(root, 'docs/plans/inspect.md'),
    '# First version\n\nRead source.js and record what it exports. No code changes.\n'
  );
  git('add', 'docs');
  git('commit', '-qm', 'saved plan');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-grilling | clarify | investigate |\n| ready-for-repro | investigate | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(root, '.issues/20261022-one.md'),
    '---\nid: 20261022-one\nstate: clarify\ngrill_later: false\n---\n# One issue\n\nPlan: docs/plans/inspect.md\n\n## Decisions\nAll questions answered: inspect the saved source; no changes.\n'
  );
  const calls = [],
    threads = new Map();
  service.codex = lifecycleTransport(root, calls, threads, setup.proposal);
  return { ...setup, calls, threads };
}
function lifecycleTransport(root, calls, threads, proposal) {
  return {
    requests: new Map(),
    ready: async () => {},
    close() {},
    resume: async (id) => calls.push({ resume: id }),
    start: async (cwd, mode) => {
      const id = 'chat-' + threads.size;
      threads.set(id, { cwd, mode });
      calls.push({ start: id, mode });
      return id;
    },
    turn: async (id, cwd, prompt, schema) => {
      calls.push({ turn: id, prompt });
      return JSON.stringify(lifecycleResponse(root, schema, proposal));
    },
    call: async (method, params) => {
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: threads.get(params.threadId).cwd } };
      assert.equal(method, 'thread/turns/list');
      return {
        data: [
          {
            id: 'finished-turn',
            status: 'completed',
            items: [{ type: 'agentMessage', text: 'Read source.js: answer is 42.' }],
          },
        ],
      };
    },
  };
}
function lifecycleResponse(root, schema, proposal) {
  const props = schema.properties;
  if (props.clarification_complete)
    return {
      clarification_complete: true,
      summary: 'All saved answers are present.',
      evidence: [join(root, '.issues/20261022-one.md')],
      questions: [],
      plan_path: 'docs/plans/inspect.md',
      plan_summary: 'Read the source and record the result.',
      proposed_plan: '',
    };
  if (props.within_plan)
    return { within_plan: true, summary: 'Read-only assignment matches the approved plan.', question: '' };
  if (props.recommendations)
    return {
      summary: 'Inspect the source.',
      recommendations: [proposal],
      routes: [],
      next_step: 'Read the source.',
      record_update: null,
    };
  return {
    outcome: 'completed',
    summary: 'Read the source: answer is 42.',
    evidence: [join(root, 'source.js')],
    notes: 'The original investigation is finished. No software changes were needed.',
    remaining: [],
    next_state: 'final',
    skipped_steps: [],
  };
}
async function finishLifecycle(service) {
  await Promise.all([...service.lifecycleTasks.values()]);
  return service.snapshot().issues[0].lifecycle;
}
function startIssueLifecycle(service) {
  const snapshot = service.snapshot();
  return service.startLifecycle({
    issueId: '20261022-one',
    state: snapshot.issues[0].state,
    basis: snapshot.reviewBasis,
  });
}
async function approveIssuePlan(service) {
  const record = await finishLifecycle(service);
  assert.equal(record.input.type, 'plan');
  return service.answerLifecycle({ issueId: '20261022-one', updated: record.updated, decision: 'approve' });
}

test('lifecycle recovers saved clarification, displays the exact plan and starts no worker before approval', async (t) => {
  const { service, calls, api } = lifecycleFixture(t);
  startIssueLifecycle(service);
  assert.equal(startIssueLifecycle(service).active, true);
  const record = await finishLifecycle(service);
  assert.equal(record.status, 'waiting');
  assert.equal(record.input.type, 'plan');
  assert.match(record.input.plan.content, /Read source.js/);
  assert.equal(service.snapshot().issues[0].state, 'investigate');
  assert.equal(api.inspect().registry.actions.length, 0);
  assert.equal(calls.filter((c) => c.start).length, 1);
  assert.equal(service.snapshot().issues[0].lifecycle.updated, record.updated);
});

test('one approved lifecycle run saves, launches, reviews and advances to explicit final acceptance', async (t) => {
  const { service, calls, api } = lifecycleFixture(t);
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  const record = await finishLifecycle(service);
  assert.equal(record.status, 'finished', record.summary);
  assert.equal(service.snapshot().issues[0].state, 'final');
  assert.equal(api.inspect().registry.actions[0].status, 'reconciled');
  assert.equal(calls.filter((c) => c.start && !c.mode).length, 1);
  assert.match(readFileSync(join(service.root, '.issues/20261022-one.md'), 'utf8'), /Implementation plan approved/);
  assert.equal(record.input, null);
});

async function blockedContinuationFixture(t) {
  const setup = lifecycleFixture(t),
    { service, api, root, threads, proposal } = setup;
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(
    report,
    readFileSync(report, 'utf8').replace('state: clarify', 'state: investigate') +
      '\nHuman answer: yes, apply the bounded correction.\n'
  );
  const [action] = api.recommend([proposal]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'existing-worker', hostId: 'codex-cli' });
  api.record(action.id, { status: 'blocked', evidence: 'Correction needed approval.' });
  const worker = service.store.add(action, 'worker', readQueue(root).head);
  service.store.update(worker, { threadId: 'existing-worker', checkout: root, status: 'blocked' });
  service.store.connected.delete(worker.id);
  threads.set('existing-worker', { cwd: root, mode: 'workspace-write' });
  const content = readFileSync(join(root, 'docs/plans/inspect.md'), 'utf8');
  const record = {
    id: 'progress-existing',
    issueId: '20261022-one',
    startHead: readQueue(root).head,
    events: [],
    attempts: [],
    retriedRuns: [worker.id],
    assessed: true,
    replan: true,
    status: 'blocked',
    plan: { path: 'docs/plans/inspect.md', content, sha256: digestReport(content) },
    approval: { sha256: digestReport(content), receipt: join(root, '.issues/answer.json') },
  };
  const { saveLifecycle } = await import('./factory-ui/lifecycle-store.mjs');
  saveLifecycle(service, record);
  return { ...setup, action, worker, record };
}

test('approved continuation resumes the same worker before reviewing its new result and creates no duplicate assignment', async (t) => {
  const { service, api, calls, action, worker } = await blockedContinuationFixture(t);
  const turn = service.codex.turn;
  service.codex.turn = async (id, cwd, prompt, schema) => {
    if (schema.properties.recommendations) {
      calls.push({ turn: id, prompt });
      return JSON.stringify({
        next_action: 'work',
        summary: 'Apply the answered correction.',
        continuation: {
          action_id: action.id,
          instruction: 'Apply the bounded correction already approved in the issue.',
          reason: 'The human answered the blocker.',
        },
        recommendations: [],
        routes: [],
        record_update: null,
        human_question: null,
        next_step: 'Continue the existing worker.',
      });
    }
    return turn(id, cwd, prompt, schema);
  };
  startIssueLifecycle(service);
  const result = await finishLifecycle(service);
  assert.equal(result.status, 'finished', result.summary);
  assert.equal(api.inspect().registry.actions.length, 1);
  assert.equal(service.store.runs.filter((r) => r.kind === 'worker').length, 1);
  assert.equal(worker.threadId, 'existing-worker');
  assert.equal(service.store.runs.find((r) => r.id === worker.id).authorization.kind, 'approved-plan');
  const work = calls.findIndex((c) => c.turn === 'existing-worker');
  const review = calls.findIndex((c) => c.prompt?.includes('Perform one coordinator evidence review'));
  assert.ok(work >= 0 && review > work);
  assert.match(calls[work].prompt, /bounded correction already approved/);
  assert.ok(calls.some((c) => c.resume === 'existing-worker'));
  assert.ok(!calls.some((c) => c.start && c.mode === 'workspace-write'));
});

test('continuations reject unknown assignments, active workers and changed inputs before resuming', async (t) => {
  const { service, record, action, worker, root } = await blockedContinuationFixture(t);
  const { saveContinuation, resumeContinuation, continuationChoice } = await import(
    './factory-ui/lifecycle-continuation.mjs'
  );
  service.lifecycleTasks.set(record.issueId, Promise.resolve());
  const result = {
    next_action: 'work',
    recommendations: [],
    record_update: null,
    continuation: { action_id: 'unknown', instruction: 'Correction', reason: 'Answered' },
  };
  assert.throws(() => saveContinuation(service, record, result), /existing blocked assignment/);
  result.continuation.action_id = action.id;
  service.store.connected.add(worker.id);
  assert.throws(() => saveContinuation(service, record, result), /still running/);
  service.store.connected.delete(worker.id);
  saveContinuation(service, record, result);
  writeFileSync(
    join(root, '.issues/20261022-one.md'),
    readFileSync(join(root, '.issues/20261022-one.md'), 'utf8') + '\nChanged answer.\n'
  );
  await assert.rejects(resumeContinuation(service, record), /changed since/);
  assert.equal(continuationChoice(service, record, readQueue(root)), null);
  assert.equal(record.pendingContinuation, null);
  assert.equal(record.replan, true);
  assert.equal(worker.status, 'blocked');
  service.lifecycleTasks.delete(record.issueId);
});

test('a continuation missing actual scope approval asks a concrete question without resuming', async (t) => {
  const { service, record, action, worker } = await blockedContinuationFixture(t);
  const { saveContinuation, checkContinuation } = await import('./factory-ui/lifecycle-continuation.mjs');
  service.lifecycleTasks.set(record.issueId, Promise.resolve());
  saveContinuation(service, record, {
    next_action: 'work',
    recommendations: [],
    record_update: null,
    continuation: { action_id: action.id, instruction: 'Change the dependency pin.', reason: 'Proposed correction' },
  });
  service.codex.turn = async () =>
    JSON.stringify({
      within_plan: false,
      summary: 'This change lacks a recorded approval.',
      question: 'May the existing worker change this dependency pin?',
    });
  assert.equal(await checkContinuation(service, record), false);
  assert.equal(record.status, 'waiting');
  assert.match(record.input.question, /dependency pin\?/);
  assert.equal(service.store.runs.find((r) => r.id === worker.id).status, 'blocked');
  service.lifecycleTasks.delete(record.issueId);
});

test('lifecycle pauses at action boundaries and snapshot or restart never resumes it', async (t) => {
  const { service, root } = lifecycleFixture(t);
  startIssueLifecycle(service);
  service.pauseLifecycle({ issueId: '20261022-one' });
  const record = await finishLifecycle(service);
  assert.equal(record.status, 'paused');
  const restarted = new FactoryUI(root);
  t.after(() => restarted.close());
  assert.equal(restarted.snapshot().issues[0].lifecycle.status, 'paused');
  assert.equal(restarted.store.connected.size, 0);
});

test('changed plan and stale answer submissions cannot authorize work', async (t) => {
  const { service, root, api } = lifecycleFixture(t);
  startIssueLifecycle(service);
  const record = await finishLifecycle(service);
  await assert.rejects(
    service.answerLifecycle({ issueId: '20261022-one', updated: 'old', decision: 'approve' }),
    /changed/
  );
  writeFileSync(join(root, 'docs/plans/inspect.md'), 'Changed plan: modify the authentication system.');
  await assert.rejects(
    service.answerLifecycle({ issueId: '20261022-one', updated: record.updated, decision: 'approve' }),
    /plan changed/
  );
  assert.equal(api.inspect().registry.actions.length, 0);
});

test('a real required decision is answered inside the issue and resolved through its original owner', async (t) => {
  const { service, root } = lifecycleFixture(t);
  const report = join(root, '.issues/20261022-one.md');
  const human = {
    version: 1,
    scopes: [{ id: 'main', revision: 1, basis_refs: ['report.md#scope'] }],
    requests: [
      {
        id: 'scope-choice',
        kind: 'decision',
        prompt: 'Which export should we inspect?',
        expected: 'An export name.',
        scope: { id: 'main', revision: 1 },
        prerequisites: [],
        blocks: [{ operation: 'advance', scope_ids: ['main'], target_state: 'investigate' }],
        status: 'pending',
        events: [],
        outcome: null,
      },
    ],
    overlays: [],
  };
  writeFileSync(
    report,
    readFileSync(report, 'utf8').replace(
      'grill_later: false',
      'grill_later: false\nhuman_input: ' + JSON.stringify(human)
    )
  );
  const turn = service.codex.turn;
  service.codex.turn = async (...args) =>
    args[3].properties.complete
      ? JSON.stringify({
          complete: true,
          summary: 'The requested export was named.',
          reason: 'The actual answer names answer, covering the current request in full.',
        })
      : turn(...args);
  startIssueLifecycle(service);
  const waiting = await finishLifecycle(service);
  assert.equal(waiting.input.type, 'human', waiting.summary);
  assert.equal(waiting.input.request.prompt, 'Which export should we inspect?');
  await service.answerLifecycle({
    issueId: '20261022-one',
    updated: waiting.updated,
    decision: 'answer',
    text: 'Inspect the answer export.',
  });
  const resumed = await finishLifecycle(service);
  assert.equal(resumed.input.type, 'plan', resumed.summary);
  assert.equal(readQueue(root).issues[0].human_input.requests[0].status, 'resolved');
  assert.equal(readQueue(root).issues[0].human_input.requests[0].outcome.actor, 'human');
});

test('human-first integration pauses inline and refuses approval after the candidate target changes', async (t) => {
  const { service, api, proposal, git, root } = lifecycleFixture(t);
  startIssueLifecycle(service);
  const initial = await finishLifecycle(service);
  const [action] = api.recommend([{ ...proposal, kind: 'implement', merge: 'human-first' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'existing-code-worker', hostId: 'local' });
  api.record(action.id, {
    status: 'completed',
    worker_revision: git('rev-parse', 'HEAD'),
    evidence: 'Finished candidate.',
  });
  await service.answerLifecycle({ issueId: '20261022-one', updated: initial.updated, decision: 'approve' });
  const waiting = await finishLifecycle(service);
  assert.equal(waiting.input.type, 'integration', waiting.summary);
  assert.equal(waiting.input.candidate, git('rev-parse', 'HEAD'));
  writeFileSync(join(root, 'new-file'), 'later target');
  git('add', 'new-file');
  git('commit', '-qm', 'later target');
  await assert.rejects(
    service.answerLifecycle({ issueId: '20261022-one', updated: waiting.updated, decision: 'approve' }),
    /candidate or target changed/
  );
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
});

test('an original recorded approval of the current plan allows Progress to continue without asking again', async (t) => {
  const { service, root } = lifecycleFixture(t);
  const { digest } = await import('./factory-ui/common.mjs');
  const report = join(root, '.issues/20261022-one.md');
  const quote = 'Human decision: I approve docs/plans/inspect.md as written. Proceed with the source inspection.';
  writeFileSync(report, readFileSync(report, 'utf8') + '\n\n' + quote + '\n');
  const turn = service.codex.turn;
  service.codex.turn = async (...args) => {
    const response = JSON.parse(await turn(...args));
    if (args[3].properties.clarification_complete)
      response.prior_approval = {
        file: report,
        quote,
        plan_sha256: digest(readFileSync(join(root, 'docs/plans/inspect.md'), 'utf8')),
      };
    return JSON.stringify(response);
  };
  startIssueLifecycle(service);
  const record = await finishLifecycle(service);
  assert.equal(record.status, 'finished', record.summary);
  assert.equal(record.approval.origin, 'reviewed-saved-human-approval');
  assert.equal(service.snapshot().issues[0].state, 'final');
});

test('a stale no-work review cannot send a later implementation back into reconciliation', async (t) => {
  const { service, root } = await evaluatedIssue(t, {
    summary: 'Implementation is still needed.',
    recommendations: [],
    routes: [],
    next_step: 'Implement the approved plan.',
  });
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nUser follow-up: continue approved implementation.\n');
  assert.equal(service.snapshot().issues[0].progress.kind, 'plan');
});

test('permission replies preserve the advertised reusable choice and reject unoffered session grants', () => {
  const connection = new CodexConnection(),
    sent = [];
  connection.send = (value) => sent.push(value);
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'ci'] } };
  connection.request({
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'worker', availableDecisions: ['accept', rule, 'cancel'] },
  });
  assert.throws(() => connection.answer('91', 'worker', { decision: 'acceptForSession' }), /offered/);
  connection.answer('91', 'worker', { decision: 'option:1' });
  assert.deepEqual(sent[0].result, { decision: rule });
});

test('technical retry cannot record a fake human answer or clear the no-progress guard', async (t) => {
  const { service, root } = lifecycleFixture(t);
  startIssueLifecycle(service);
  await finishLifecycle(service);
  const record = service.lifecycleRuns['20261022-one'];
  record.input = { type: 'retry', question: 'Implementation is unfinished.' };
  const before = readFileSync(join(root, '.issues/20261022-one.md'), 'utf8');
  await assert.rejects(
    service.answerLifecycle({ issueId: record.issueId, updated: record.updated, text: 'just continue' }),
    /not a question/
  );
  assert.equal(readFileSync(join(root, '.issues/20261022-one.md'), 'utf8'), before);
});

test('live activity keeps command output and combines streamed messages without duplicating completion', async (t) => {
  const { service } = fixture(t),
    run = service.store.add({ id: 'output' }, 'worker', 'base');
  service.store.update(run, { threadId: 'output-chat' });
  const event = (method, params) => service.store.event({ method, params: { threadId: 'output-chat', ...params } });
  event('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'Tests passed\n' });
  event('item/agentMessage/delta', { itemId: 'msg', delta: 'Checking ' });
  event('item/agentMessage/delta', { itemId: 'msg', delta: 'the result.' });
  event('item/completed', { item: { id: 'msg', type: 'agentMessage', text: 'Checking the result.' } });
  event('item/completed', {
    item: {
      id: 'cmd',
      type: 'commandExecution',
      command: 'npm test',
      aggregatedOutput: 'Tests passed\n',
      exitCode: 0,
      status: 'completed',
    },
  });
  const output = service.store.list(new Map())[0].output;
  assert.equal(output.length, 2);
  assert.equal(output[0].text, 'Tests passed\n');
  assert.equal(output[0].exitCode, 0);
  assert.equal(output[1].text, 'Checking the result.');
  assert.match(readFileSync(join(service.store.directory, run.id + '.jsonl'), 'utf8'), /outputDelta/);
});

test('automatic permission review updates live output and retains refusals without exposing private reasoning', (t) => {
  const { service } = fixture(t),
    run = service.store.add({ id: 'automatic-approval' }, 'worker', 'base');
  service.store.update(run, { threadId: 'approval-chat' });
  const event = (status) =>
    service.store.event({
      method: `item/autoApprovalReview/${status === 'inProgress' ? 'started' : 'completed'}`,
      params: {
        threadId: 'approval-chat',
        reviewId: 'review',
        review: { status, rationale: 'The command needs additional authorization.', privateReasoning: 'hidden' },
      },
    });
  event('inProgress');
  assert.match(service.store.list(new Map())[0].output[0].text, /Checking permission automatically/);
  for (const status of ['approved', 'denied', 'timedOut', 'aborted', 'unknown']) {
    event(status);
    const output = service.store.list(new Map())[0].output;
    assert.equal(output.length, 1);
    assert.equal(output[0].status, status === 'approved' ? 'completed' : 'blocked');
    assert.doesNotMatch(output[0].text, /hidden/);
  }
  assert.equal(run.approvals, undefined);
});

test('native file and network grants retain their session scope without accepting browser-supplied permissions', () => {
  const connection = new CodexConnection(),
    sent = [];
  connection.send = (value) => sent.push(value);
  const permissions = { fileSystem: { read: ['/tmp/report.md'] }, network: { enabled: true } };
  connection.request({
    id: 92,
    method: 'item/permissions/requestApproval',
    params: { threadId: 'worker', permissions },
  });
  assert.throws(() => connection.answer('92', 'other-chat', { decision: 'session' }), /no longer pending/);
  assert.equal(sent.length, 0);
  connection.answer('92', 'worker', { decision: 'session', permissions: { fileSystem: { write: ['/'] } } });
  assert.deepEqual(sent[0].result, { permissions, scope: 'session' });
});

async function healthFixture(t, thread) {
  const { installWorkerHealth } = await import('./factory-ui/worker-health.mjs');
  const events = [],
    ended = [];
  const connection = new CodexConnection({ onEvent: (e) => events.push(e) });
  connection.turns.set('live-chat', {
    id: 'live-turn',
    text: '',
    resolve: (text) => ended.push({ text }),
    reject: (error) => ended.push({ error: error.message }),
  });
  connection.call = async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.equal(params.threadId, 'live-chat');
    return { thread };
  };
  const service = {
    codex: connection,
    snapshot: () => ({ runs: [{ id: 'run', threadId: 'live-chat', status: 'running', connected: true, events: [] }] }),
    close: () => connection.close(),
  };
  const monitor = installWorkerHealth(service);
  t.after(() => service.close());
  return { service, connection, monitor, events, ended };
}

test('live worker health trusts its owning active connection over interrupted saved history', async (t) => {
  const { service, connection, monitor, ended } = await healthFixture(t, {
    status: { type: 'active' },
    turns: [{ id: 'live-turn', status: 'interrupted', items: [] }],
  });
  await monitor.check();
  assert.equal(service.snapshot().runs[0].health.state, 'active');
  assert.equal(connection.turns.has('live-chat'), true);
  assert.equal(ended.length, 0);
});

test('an idle owning connection reconciles a missed terminal event only for the exact tracked turn', async (t) => {
  const { connection, monitor, ended } = await healthFixture(t, {
    status: { type: 'idle' },
    turns: [{ id: 'live-turn', status: 'interrupted', items: [] }],
  });
  await monitor.check();
  assert.equal(connection.turns.has('live-chat'), false);
  assert.match(ended[0].error, /interrupted/);
});

test('missed completion retains the returned result while unknown or newer work is left alone', async (t) => {
  const payload = JSON.stringify({ outcome: 'completed' });
  const { connection, monitor, ended } = await healthFixture(t, {
    status: { type: 'idle' },
    turns: [{ id: 'live-turn', status: 'completed', items: [{ type: 'agentMessage', text: payload }] }],
  });
  await monitor.check();
  assert.equal(ended[0].text, payload);
  connection.turns.set('live-chat', { id: 'new-turn' });
  await monitor.check();
  assert.equal(connection.turns.has('live-chat'), true);
  assert.equal(ended.length, 1);
});

test('a status read cannot end a newer turn or infer interruption from an unloaded chat', async (t) => {
  const { service, connection, monitor, ended } = await healthFixture(t, {
    status: { type: 'notLoaded' },
    turns: [{ id: 'live-turn', status: 'interrupted' }],
  });
  await monitor.check();
  assert.equal(service.snapshot().runs[0].health.state, 'unconfirmed');
  assert.equal(ended.length, 0);
  connection.call = async () => {
    connection.turns.set('live-chat', { id: 'new-turn' });
    return { thread: { status: { type: 'idle' }, turns: [{ id: 'live-turn', status: 'interrupted' }] } };
  };
  await monitor.check();
  assert.equal(connection.turns.get('live-chat').id, 'new-turn');
  assert.equal(ended.length, 0);
});

async function activityScreen(t) {
  const { JSDOM } = await import('jsdom');
  const { service } = lifecycleFixture(t);
  const html = readFileSync(resolve('scripts/factory-ui/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/#/issue/20261022-one', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  const script = html
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/\n\s*refresh\(\);\n\s*setInterval\(refresh, 4000\);/, '');
  dom.window.eval(
    script +
      '\nwindow.screenTest = { show(value) { data = value; render(); }, update(value) { data = value; updateLiveOutput(); } };'
  );
  const snapshot = service.snapshot();
  snapshot.issues[0].lifecycle = { status: 'running', summary: 'Reading source', childRunId: 'live', events: [] };
  snapshot.runs.push({
    id: 'live',
    issueId: '20261022-one',
    connected: true,
    status: 'running',
    kind: 'worker',
    output: [{ text: 'Starting tests', at: '2026-10-24T12:00:00Z' }],
    events: [],
    approvals: [],
  });
  dom.window.screenTest.show(snapshot);
  return { window: dom.window, snapshot };
}

test('native permission screen explains chat scope and actual read, write and network access', async (t) => {
  const { window, snapshot } = await activityScreen(t);
  const request = {
    id: 'permission',
    method: 'item/permissions/requestApproval',
    params: {
      reason: 'Run related temporary checks.',
      permissions: {
        fileSystem: {
          read: ['/tmp/input'],
          entries: [{ access: 'write', path: { type: 'path', path: '/tmp/output' } }],
        },
        network: { enabled: true },
      },
    },
  };
  request.options = approvalOptions(request);
  snapshot.runs.at(-1).approvals = [request];
  window.screenTest.show(snapshot);
  const card = window.document.querySelector('[data-view-id="permission-live-permission"]');
  assert.match(card.textContent, /Read: \/tmp\/input/);
  assert.match(card.textContent, /Read and write: \/tmp\/output/);
  assert.match(card.textContent, /not limited to one host or local service/);
  assert.match(card.textContent, /related commands and later turns in this connected chat/);
  assert.equal(card.querySelector('[data-decision="session"]').textContent, 'Allow for this chat');
  assert.ok(card.querySelector('[data-decision="once"]'));
  assert.ok(card.querySelector('[data-decision="deny"]'));
});

test('activity header shows live confirmation, last activity and result checks without exposing private reasoning', async (t) => {
  const { window, snapshot } = await activityScreen(t);
  const run = snapshot.runs.at(-1);
  run.health = { state: 'active', checkedAt: '2026-10-25T12:00:00Z', lastActivityAt: '2026-10-25T11:59:55Z' };
  run.events = [
    {
      method: 'item/completed',
      at: '2026-10-25T11:59:55Z',
      params: { item: { type: 'reasoning', text: 'private reasoning content' } },
    },
  ];
  window.screenTest.show(snapshot);
  const header = window.document.querySelector('[data-live-health="live"]');
  assert.match(header.textContent, /Codex confirmed this chat is active/);
  assert.match(header.textContent, /Last live update/);
  assert.doesNotMatch(window.document.body.textContent, /private reasoning content/);
  run.status = 'checking';
  run.health.state = 'unconfirmed';
  window.screenTest.update(snapshot);
  assert.match(window.document.querySelector('[data-live-health="live"]').textContent, /Checking the returned result/);
});

test('activity screen shows the current step and preserves expanded details, native drafts and log reading position', async (t) => {
  const { window, snapshot } = await activityScreen(t),
    document = window.document;
  assert.match(document.querySelector('.lifecycle-progress').textContent, /Current step: Clarify/);
  assert.match(document.querySelector('[data-lifecycle-start]').textContent, /Working…/);
  assert.doesNotMatch(document.body.textContent, /Progress in progress/);
  const notes = [...document.querySelectorAll('details')].find(
    (element) => element.querySelector('summary')?.textContent === 'Decisions'
  );
  notes.querySelector('summary').click();
  const output = document.getElementById('live-output');
  Object.defineProperties(output, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  output.scrollTop = 350;
  output.onscroll();
  snapshot.runs.at(-1).output.push({ text: 'Tests passed', at: '2026-10-24T12:01:00Z' });
  window.screenTest.show(snapshot);
  assert.equal(
    [...document.querySelectorAll('details')].find(
      (element) => element.querySelector('summary')?.textContent === 'Decisions'
    ).open,
    true
  );
  assert.equal(document.getElementById('live-output').scrollTop, 350);
  assert.match(document.getElementById('live-output').textContent, /Tests passed/);
  const saved = JSON.parse(window.localStorage.getItem('factory-expanded-v2'));
  assert.ok(Object.values(saved).includes(true));
});

test('a stopped technical review has no answer box and does not repeat its explanation', async (t) => {
  const { window, snapshot } = await activityScreen(t);
  const summary = 'Implementation is unfinished; no completed step can be recorded.';
  snapshot.issues[0].lifecycle = {
    status: 'blocked',
    summary,
    input: { type: 'retry', question: summary },
    canResume: false,
    events: [],
  };
  window.screenTest.show(snapshot);
  const panel = window.document.querySelector('.lifecycle-progress');
  assert.equal(panel.querySelector('textarea'), null);
  assert.equal(panel.textContent.split(summary).length, 2);
  assert.match(panel.textContent, /Progress stopped/);
  assert.equal(panel.querySelector('[data-lifecycle-start]').textContent, 'Continue…');
  assert.equal(panel.querySelector('[data-lifecycle-start]').disabled, true);
});

test('an implementation-stage prerequisite is launched and reviewed without sending the issue back to Investigate', async (t) => {
  const { service, root, api, proposal } = fixture(t);
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-fix | implement | verify |\n| ready-to-verify | verify | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8').replace('state: investigate', 'state: implement'));
  const [action] = api.recommend([proposal]);
  assert.equal(service.snapshot().issues[0].progress.kind, 'launch');
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'prerequisite', hostId: 'local' });
  api.record(action.id, { status: 'completed', evidence: 'Dependency compatibility established.' });
  assert.equal(service.snapshot().issues[0].progress.kind, 'review');
  assert.equal(service.snapshot().issues[0].state, 'implement');
});

test('a real planning question explains the missing decision and resumes planning after the actual answer', async (t) => {
  const { service, root } = lifecycleFixture(t);
  startIssueLifecycle(service);
  await finishLifecycle(service);
  const original = service.codex.turn;
  service.codex.turn = async (...args) =>
    args[3].properties.recommendations
      ? JSON.stringify({
          summary: 'A scope choice is needed.',
          recommendations: [],
          routes: [],
          next_step: 'Choose how to handle the related admin work.',
          record_update: null,
          next_action: 'question',
          human_question: {
            question: 'Should we handle the admin work separately?',
            why: 'The saved batch includes a second issue outside this selection.',
            expected: 'Choose separate work or revise the approved batch.',
          },
        })
      : original(...args);
  await approveIssuePlan(service);
  const record = await finishLifecycle(service);
  assert.equal(record.status, 'waiting');
  assert.equal(record.input.type, 'questions');
  assert.equal(record.input.origin, 'next-action');
  assert.match(record.input.questions[0].question, /admin work separately\?/);
  assert.equal(service.store.runs.filter((r) => r.kind === 'reconciliation').length, 0);
  assert.equal(readQueue(root).issues[0].state, 'investigate');
});

test('blocked review finds the unfinished task once instead of looping or inventing an answer request', async (t) => {
  const { service } = lifecycleFixture(t);
  const original = service.codex.turn;
  let evaluations = 0;
  service.codex.turn = async (...args) => {
    const schema = args[3].properties;
    if (schema.recommendations && ++evaluations > 1)
      return JSON.stringify({
        summary: 'A scope decision is needed.',
        recommendations: [],
        routes: [],
        next_step: 'Choose the implementation scope.',
        next_action: 'question',
        human_question: {
          question: 'Should the admin changes be a separate task?',
          why: 'The original batch spans a second issue.',
          expected: 'Choose separate work or revise the batch.',
        },
        record_update: null,
      });
    if (schema.next_state)
      return JSON.stringify({
        outcome: 'blocked',
        summary: 'The larger implementation is unfinished.',
        notes: 'The investigation is not the application implementation.',
        evidence: [],
        remaining: ['Implement the approved plan.'],
        next_state: null,
        skipped_steps: [],
      });
    return original(...args);
  };
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  const record = await finishLifecycle(service);
  assert.equal(record.input.type, 'questions', record.summary);
  assert.equal(evaluations, 2);
  assert.equal(service.store.runs.filter((r) => r.kind === 'worker').length, 1);
  assert.equal(service.store.runs.filter((r) => r.kind === 'coordinator').length, 1);
});

test('native question drafts survive live refreshes but do not leak into a later lifecycle question', async (t) => {
  const { window, snapshot } = await activityScreen(t);
  const run = snapshot.runs.at(-1);
  run.approvals = [
    {
      id: 'decision',
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'scope', question: 'Which scope?' }] },
    },
  ];
  window.screenTest.show(snapshot);
  window.document.querySelector('[data-question]').value = 'Auth only';
  window.screenTest.show(snapshot);
  assert.equal(window.document.querySelector('[data-question]').value, 'Auth only');
  const record = {
    status: 'waiting',
    events: [],
    updated: 'first',
    input: { type: 'questions', reportHash: 'one', questions: [{ question: 'First question?' }] },
  };
  snapshot.issues[0].lifecycle = record;
  window.screenTest.show(snapshot);
  window.document.getElementById('lifecycle-answer-20261022-one').value = 'First answer';
  record.input = { type: 'questions', reportHash: 'two', questions: [{ question: 'Different question?' }] };
  window.screenTest.show(snapshot);
  assert.equal(window.document.getElementById('lifecycle-answer-20261022-one').value, '');
});

test('administrative notes cannot re-enable the same stopped review', async (t) => {
  const { service, root } = lifecycleFixture(t);
  const original = service.codex.turn;
  service.codex.turn = async (...args) =>
    args[3].properties.recommendations
      ? JSON.stringify({
          summary: 'No valid assignment was established.',
          recommendations: [],
          routes: [],
          next_step: 'The saved batch needs a scope decision before work can be assigned.',
          next_action: 'blocked',
          human_question: null,
          record_update: null,
        })
      : original(...args);
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  const stopped = await finishLifecycle(service),
    count = service.store.runs.length;
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.input, null);
  assert.equal(stopped.canResume, false);
  const report = join(root, '.issues/20261022-one.md');
  writeFileSync(report, readFileSync(report, 'utf8') + '\nAdministrative note: just continue.\n');
  assert.equal(service.snapshot().issues[0].lifecycle.canResume, false);
  assert.throws(() => startIssueLifecycle(service), /nothing relevant has changed/);
  assert.equal(service.store.runs.length, count);
  const { retainAnswer } = await import('./factory-ui/lifecycle-store.mjs');
  retainAnswer(service, service.lifecycleRuns['20261022-one'], {
    type: 'clarification',
    answer: 'Use the bounded selected scope.',
  });
  assert.equal(service.snapshot().issues[0].lifecycle.canResume, true);
});

test('live output redacts known credentials before storing or displaying events', async (t) => {
  const { service } = fixture(t),
    run = service.store.add({ id: 'redaction' }, 'worker', 'base');
  service.store.update(run, { threadId: 'private-output' });
  const previous = process.env.FACTORY_ACTIVITY_TEST_SECRET;
  process.env.FACTORY_ACTIVITY_TEST_SECRET = 'fixture-private-value-012345';
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_ACTIVITY_TEST_SECRET;
    else process.env.FACTORY_ACTIVITY_TEST_SECRET = previous;
  });
  service.store.event({
    method: 'item/commandExecution/outputDelta',
    params: { threadId: 'private-output', itemId: 'cmd', delta: 'token=' + process.env.FACTORY_ACTIVITY_TEST_SECRET },
  });
  const saved = JSON.stringify(service.store.list(new Map()));
  assert.doesNotMatch(saved, /fixture-private-value/);
  assert.match(saved, /redacted/);
  assert.doesNotMatch(readFileSync(join(service.store.directory, run.id + '.jsonl'), 'utf8'), /fixture-private-value/);
});

test('an explicit file or checklist decision resumes a stopped lifecycle without treating a status as an answer', async (t) => {
  const { continueLifecycleAfter } = await import('./factory-ui/lifecycle-control.mjs');
  const { service } = lifecycleFixture(t);
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  await finishLifecycle(service);
  const record = service.lifecycleRuns['20261022-one'];
  record.status = 'blocked';
  record.input = null;
  record.attempts = ['old-action'];
  continueLifecycleAfter(service, record.issueId);
  assert.equal(record.status, 'running');
  const finished = await finishLifecycle(service);
  assert.equal(finished.status, 'finished');
  assert.equal(service.snapshot().issues[0].state, 'final');
});

test('automatic stage expansion follows the current step while explicit user expansion stays open', async (t) => {
  const { window, snapshot } = await activityScreen(t);
  const stage = (name) => window.document.querySelector('[data-step-id="20261022-one:' + name + '"]');
  const oldKey = 'ready-for-grilling:clarify',
    nextKey = 'ready-for-repro:investigate';
  assert.equal(stage(oldKey).open, true);
  assert.equal(stage(nextKey).open, false);
  snapshot.issues[0].state = 'investigate';
  window.screenTest.show(snapshot);
  assert.equal(stage(oldKey).open, false);
  assert.equal(stage(nextKey).open, true);
});

test('a newer task recommendation supersedes an older stopped reconciliation', async (t) => {
  const { service, proposal } = fixture(t);
  const queue = service.snapshot();
  service.store.runs.push({
    id: 'old-bookkeeping',
    events: [],
    kind: 'reconciliation',
    issueId: '20261022-one',
    issueState: 'investigate',
    reviewBasis: queue.reviewBasis,
    status: 'blocked',
    summary: 'Implementation remains unfinished.',
    updated: '2026-10-24T01:00:00Z',
  });
  service.store.save();
  service.codex = {
    requests: new Map(),
    start: async () => 'next-task-chat',
    close() {},
    turn: async () =>
      JSON.stringify({
        summary: 'Run the unfinished prerequisite.',
        next_action: 'work',
        next_step: 'Ask the coordinator to execute the prerequisite.',
        recommendations: [proposal],
        routes: [],
      }),
  };
  const started = service.evaluate(service.snapshot().reviewBasis, '20261022-one');
  await settle(service, started.runId);
  const issue = service.snapshot().issues[0];
  assert.equal(issue.progress.kind, 'save-review');
  assert.doesNotMatch(issue.latestResult.nextStep, /Ask the coordinator/);
  const { lifecycleWorkBasis } = await import('./factory-ui/lifecycle-stop.mjs');
  const record = { issueId: issue.id, status: 'blocked', events: [], attempts: [] };
  record.stopBasis = lifecycleWorkBasis(readQueue(service.root), issue, record);
  service.lifecycleRuns[issue.id] = record;
  assert.equal(service.snapshot().issues[0].lifecycle.canResume, true);
  service.progressStart(service.progressPreflight(issue.id, issue.state).token);
  assert.equal(service.snapshot().issues[0].progress.kind, 'launch');
});

test('approved progress saves and launches the new task after an unsuccessful bookkeeping review', async (t) => {
  const { service, proposal } = lifecycleFixture(t);
  const original = service.codex.turn;
  let evaluations = 0;
  service.codex.turn = async (...args) => {
    if (args[3].properties.recommendations && ++evaluations === 1)
      return JSON.stringify({
        summary: 'Check existing work.',
        recommendations: [],
        routes: [],
        next_action: 'reconcile',
      });
    if (unfinishedBookkeeping(args, service)) return JSON.stringify(unfinishedBookkeepingResult());
    return original(...args);
  };
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  const record = await finishLifecycle(service);
  assert.equal(
    record.status,
    'finished',
    JSON.stringify({
      summary: record.summary,
      events: record.events,
      runs: service.store.runs.map((r) => ({ kind: r.kind, status: r.status, summary: r.summary })),
    })
  );
  assert.equal(service.store.runs.filter((r) => r.kind === 'evaluation').length, 2);
  assert.equal(service.store.runs.filter((r) => r.kind === 'worker').length, 1);
  assert.equal(service.snapshot().issues[0].state, 'final');
  assert.equal(service.store.runs.findLast((r) => r.kind === 'evaluation').savedActions.length, 1);
  assert.equal(proposal.merge, 'none');
});

function unfinishedBookkeeping(args, service) {
  return args[3].properties.next_state && !service.store.runs.some((r) => r.kind === 'worker');
}
function unfinishedBookkeepingResult() {
  return {
    outcome: 'blocked',
    summary: 'The task is unfinished.',
    notes: 'Work is needed.',
    evidence: [],
    remaining: ['Read source.js'],
    next_state: null,
    skipped_steps: [],
  };
}

test('native inspection sees the same waiting question and plan approval as the issue coordinator', async (t) => {
  const { service, root } = lifecycleFixture(t);
  startIssueLifecycle(service);
  const record = await finishLifecycle(service);
  const { execFileSync } = await import('node:child_process');
  const before = readFileSync(join(root, '.issues/factory-ui/lifecycle.json'), 'utf8');
  const inspection = JSON.parse(
    execFileSync(process.execPath, [resolve('scripts/factory.mjs'), '20261022-one'], { cwd: root, encoding: 'utf8' })
  );
  assert.equal(inspection.progress['20261022-one'].input.type, 'plan');
  assert.equal(inspection.progress['20261022-one'].id, record.id);
  assert.equal(readFileSync(join(root, '.issues/factory-ui/lifecycle.json'), 'utf8'), before);
});

test('progress writes preserve other issues saved by another coordinator instance', async (t) => {
  const { root } = fixture(t);
  const { writeProgress, readProgress } = await import('./factory-progress.mjs');
  writeProgress(root, { issueId: 'one', status: 'waiting', input: { question: 'Which option?' } });
  writeProgress(root, { issueId: 'two', status: 'paused' });
  writeProgress(root, { issueId: 'one', status: 'finished' });
  assert.equal(readProgress(root).two.status, 'paused');
  assert.equal(readProgress(root).one.status, 'finished');
});

function nativeRecordInput(root) {
  const queue = readQueue(root),
    issue = queue.issues[0];
  return {
    issue_id: issue.id,
    expected_state: issue.state,
    revision: queue.head,
    basis: factory(root).inspect().completion_basis,
    report_sha256: digestReport(issue.content),
    chat_id: 'native-coordinator',
  };
}

test('native implementation checks are fresh in the UI without any UI chat or run history', async (t) => {
  const { root, service, path, result } = implementationFixture(t);
  const { recordPlanChecks } = await import('./factory-record.mjs');
  recordPlanChecks(root, { ...nativeRecordInput(root), plan_path: path, result });
  assert.equal(existsSync(service.store.path), false);
  const issue = service.snapshot().issues[0];
  assert.equal(issue.implementation.fresh, true);
  assert.equal(issue.plan_verification.steps.length, 3);
  assert.equal(issue.human_checks[0].status, 'pending');
  const original = readFileSync(join(root, 'source.js'), 'utf8');
  writeFileSync(join(root, 'source.js'), original + '\n// changed\n');
  assert.equal(service.snapshot().issues[0].implementation.fresh, false);
});

test('native completion and UI completion write the same stage history and reject stale or invented acceptance', async (t) => {
  const { root, service } = lifecycleFixture(t);
  const { recordCompletion } = await import('./factory-record.mjs');
  const input = {
    ...nativeRecordInput(root),
    result: {
      outcome: 'completed',
      summary: 'Clarification is complete.',
      notes: 'Saved answers settle the request.',
      evidence: [join(root, 'source.js')],
      remaining: ['Investigate the source.'],
      next_state: 'investigate',
      skipped_steps: [],
      stage_records: [{ state: 'clarify', outcome: 'completed', reason: 'The saved answers settle the scope.' }],
      commit_revision: null,
      verification_summary: null,
      audit_summary: null,
    },
  };
  const { execFileSync } = await import('node:child_process');
  const payload = join(root, '.issues/native-completion.json');
  writeFileSync(payload, JSON.stringify(input));
  const recorded = JSON.parse(
    execFileSync(process.execPath, [resolve('scripts/factory.mjs'), 'complete', payload], {
      cwd: root,
      encoding: 'utf8',
    })
  );
  assert.equal(recorded.state, 'investigate');
  const issue = service.snapshot().issues[0];
  assert.equal(issue.state, 'investigate');
  assert.equal(issue.lifecycle_history[0].outcome, 'completed');
  assert.equal(issue.lifecycle_history[0].authorization.kind, 'coordinator');
  assert.equal(issue.stageStates.clarify.status, 'completed');
  assert.throws(() => recordCompletion(root, input), /issue moved/);
  const fresh = { ...nativeRecordInput(root), result: { ...input.result, human_check_update: { status: 'passed' } } };
  assert.throws(() => recordCompletion(root, fresh), /human decisions/);
  assert.equal(service.snapshot().issues[0].state, 'investigate');
});

test('approved lifecycle actions retain plan authorization without claiming a new human click', async (t) => {
  const { service, calls } = lifecycleFixture(t);
  startIssueLifecycle(service);
  await approveIssuePlan(service);
  await finishLifecycle(service);
  const worker = service.store.runs.find((r) => r.kind === 'worker');
  assert.equal(service.store.runs.find((r) => r.id === worker.id).authorization.kind, 'approved-plan');
  const action = service.api.inspect().registry.actions.find((a) => a.id === worker.actionId);
  assert.equal(action.authorization.kind, 'approved-plan');
  assert.equal(action.operations[0].authorization.plan_sha256, worker.authorization.plan_sha256);
  assert.equal(worker.authorization.plan_sha256, service.lifecycleRuns['20261022-one'].approval.sha256);
  const prompt = calls.find((c) => c.turn === worker.threadId).prompt;
  assert.match(prompt, /under the approved plan/);
  assert.doesNotMatch(prompt, /human explicitly chose Start worker/i);
  const note = service.snapshot().issues[0].content;
  assert.doesNotMatch(note, /Recorded from the issue screen by an explicit user action/);
});

test('native completion respects the shared active coordinator and unanswered UI request', async (t) => {
  const { root } = fixture(t);
  const { writeProgress } = await import('./factory-progress.mjs');
  const { recordCompletion } = await import('./factory-record.mjs');
  const input = nativeRecordInput(root);
  writeProgress(root, { issueId: input.issue_id, status: 'running' });
  assert.throws(() => recordCompletion(root, input), /coordinator is active/);
  writeProgress(root, {
    issueId: input.issue_id,
    status: 'waiting',
    input: { type: 'questions', questions: [{ question: 'Which scope?' }] },
  });
  assert.throws(() => recordCompletion(root, input), /original response control/);
  assert.equal(readQueue(root).issues[0].state, 'investigate');
});

test('automatic same-worker correction is recorded as plan continuation, not a human follow-up', async (t) => {
  const { service, api, proposal, root } = fixture(t);
  const [action] = api.recommend([proposal]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'same-worker', hostId: 'codex-cli' });
  api.record(action.id, { status: 'blocked', evidence: 'A technical correction is needed.' });
  const run = service.store.add(action, 'worker', readQueue(root).head);
  service.store.update(run, { threadId: 'same-worker', checkout: root, status: 'blocked' });
  service.store.connected.delete(run.id);
  let prompt;
  service.codex = {
    requests: new Map(),
    close() {},
    resume: async () => {},
    turn: async (_id, _cwd, text) => {
      prompt = text;
      return JSON.stringify({
        outcome: 'blocked',
        summary: 'Need the next technical correction.',
        evidence: 'Existing results.',
        remaining: [],
      });
    },
  };
  const { planAuthorization } = await import('./factory-authorization.mjs');
  const authorization = planAuthorization(
    {
      issueId: '20261022-one',
      id: 'progress-one',
      approval: { sha256: 'saved-plan-hash', receipt: '/tmp/approval.json' },
    },
    'resume'
  );
  await service.resume(run.id, 'Retry the bounded dependency operation.', authorization);
  const recorded = api.inspect().registry.actions[0];
  assert.match(recorded.evidence, /under the approved plan/);
  assert.equal(
    recorded.operations.findLast((o) => o.operation === 'record-running').authorization.kind,
    'approved-plan'
  );
  assert.doesNotMatch(recorded.evidence, /Human explicitly resumed/);
  await settle(service, run.id);
  assert.match(prompt, /approved plan/);
  assert.ok(prompt.includes(workerPermissionGuidance));
  assert.doesNotMatch(prompt, /Human follow-up/);
  assert.equal(service.store.runs.find((r) => r.id === run.id).authorization.kind, 'approved-plan');
});

test('native check recording cannot invent the user waiver reserved for the Skip button', async (t) => {
  const { root, path, result } = implementationFixture(t);
  const { recordPlanChecks } = await import('./factory-record.mjs');
  result.steps[0].criteria[0].manual_skip = { actor: 'human', reason: 'Invented' };
  assert.throws(
    () => recordPlanChecks(root, { ...nativeRecordInput(root), plan_path: path, result }),
    /cannot invent a manual skip/
  );
  assert.equal(readQueue(root).issues[0].plan_verification, undefined);
});

test('native completion reuses legacy UI check receipts without starting a replacement review', async (t) => {
  const { service, root, path } = implementationFixture(t);
  const run = await settle(service, checkPlan(service, path).runId);
  unlinkSync(join(root, '.issues/factory-progress', run.id + '.json'));
  const { requireImplementationPasses } = await import('./factory-ui/plan-checks.mjs');
  const queue = readQueue(root),
    issue = queue.issues[0];
  assert.doesNotThrow(() =>
    requireImplementationPasses({ store: { list: () => [] }, codex: { requests: new Map() } }, queue, issue)
  );
  assert.equal(service.snapshot().issues[0].implementation.fresh, true);
});

test('native completion rejects an inspection whose dependencies or assignments changed', async (t) => {
  const { root } = fixture(t);
  const { recordCompletion } = await import('./factory-record.mjs');
  const input = nativeRecordInput(root);
  writeFileSync(
    join(root, '.issues/20261022-other.md'),
    '---\nid: 20261022-other\nstate: investigate\n---\nDependency changed.\n'
  );
  assert.throws(() => recordCompletion(root, input), /inspection changed/);
  assert.equal(readQueue(root).issues[0].state, 'investigate');
});
