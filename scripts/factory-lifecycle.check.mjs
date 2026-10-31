import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { toggleRoute, routeBasis } from './factory-ui/route-toggle.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';
import { validateRoutes } from './factory-ui/lifecycle.mjs';

test('captured historical skips do not block an implementation route or authorize new required skips', (t) => {
  const { root, report } = lifecycleFixture(t);
  const original = readFileSync(report, 'utf8');
  writeFileSync(report, original.replace('state: clarify', 'state: implement'));
  const queue = readQueue(root),
    issue = queue.issues[0];
  const recorded = {
    state: 'clarify',
    outcome: 'skipped',
    source: { kind: 'original-report' },
    reason: 'The original report bounds the requested outcome.',
    at: '2026-10-27T14:00:55.597Z',
    evidence: [report],
  };
  issue.lifecycle_history = [recorded];
  const routes = [
    {
      issueId: issue.id,
      steps: [
        { state: 'clarify', decision: 'skip', reason: 'Preserve the recorded capture skip.' },
        { state: 'implement', decision: 'take', reason: 'Implement the approved plan.' },
      ],
    },
  ];
  const validate = () => validateRoutes(queue, routes, issue.id);
  assert.deepEqual(validate(), routes);
  assert.deepEqual(issue.lifecycle_history, [recorded]);
  assert.equal(readFileSync(report, 'utf8'), original.replace('state: clarify', 'state: implement'));
  for (const history of [
    [],
    [{ ...recorded, evidence: [] }],
    [{ ...recorded, outcome: 'completed' }],
    [recorded, { outcome: 'reopened' }],
  ]) {
    issue.lifecycle_history = history;
    assert.throws(validate, /Clarify is required/);
  }
  issue.lifecycle_history = [recorded];
  queue.lifecycle.unshift({ state: 'intake', next: 'clarify', role: 'custom' });
  for (const state of ['clarify', 'intake']) {
    issue.state = state;
    assert.throws(validate, /Clarify is required/);
  }
  issue.state = 'implement';
  for (const state of ['implement', 'verify']) {
    issue.lifecycle_history = [{ ...recorded, state }];
    routes[0].steps = [{ state, decision: 'skip', reason: 'Must remain protected.' }];
    assert.throws(validate, /required|explicit acceptance/);
  }
});

function lifecycleFixture(t) {
  const { root, git } = gitFixture(t, 'timey-lifecycle-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":true}');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    `| Role | State | Next | Meaning |
| ready-for-grilling | clarify | investigate | Clarify |
| ready-for-repro | investigate | prototype | Investigate |
| ready-to-prototype | prototype | implement | Prototype |
| ready-to-fix | implement | verify | Implement |
| ready-to-verify | verify | commit | Verify |
| ready-for-commit | commit | final | Commit |
| ready-to-close | final | closed | Accept |
| closed | closed | — | Closed |
`
  );
  const report = join(root, '.issues/20261026-one.md');
  writeFileSync(
    report,
    '---\nid: 20261026-one\ntitle: Lifecycle fixture\nstate: clarify\ncategory: enhancement\ngrill_later: false\n---\nOriginal report\n'
  );
  const helper = join(root, '.agents/skills/issues/scripts');
  mkdirSync(helper, { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json'])
    cpSync(resolve('.agents/skills/issues/scripts', name), join(helper, name));
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const input = (target = 'prototype') => {
    const queue = readQueue(root),
      issue = queue.issues[0];
    return { issueId: issue.id, state: issue.state, target, basis: routeBasis(queue, issue, service.store.runs) };
  };
  return { root, service, input, report };
}

test('future choices persist without changing reports, other routes or history; stale/concurrent and protected writes fail', (t) => {
  const { root, service, input, report } = lifecycleFixture(t);
  const original = readFileSync(report, 'utf8');
  service.ownServer();
  service.store.runs.push({
    id: 'saved',
    kind: 'evaluation',
    status: 'completed',
    events: [],
    savedRoutes: [
      {
        issueId: '20261026-one',
        steps: [
          { state: 'investigate', decision: 'take', reason: 'Retain this reason' },
          { state: '@integration', decision: 'take', reason: 'Separate integration' },
        ],
      },
    ],
  });
  service.store.save();
  const stale = input();
  toggleRoute(service, stale);
  assert.throws(() => toggleRoute(service, stale), /route changed/);
  assert.equal(readFileSync(report, 'utf8'), original);
  assert.deepEqual(
    service.store.runs.at(-1).savedRoutes[0].steps.slice(0, 2),
    service.store.runs[0].savedRoutes[0].steps.map((step) => ({ ...step, source: null }))
  );
  service.store.reload();
  assert.equal(service.store.runs.at(-1).savedRoutes[0].steps.at(-1).decision, 'skip');
  assert.deepEqual(service.store.runs.at(-1).savedRoutes[0].steps.at(-1).source, { kind: 'user' });
  toggleRoute(service, input());
  assert.equal(service.store.runs.at(-1).savedRoutes[0].steps.at(-1).decision, 'take');
  for (const state of ['clarify', 'implement', 'verify', 'commit', '@integration', 'unknown'])
    assert.throws(() => toggleRoute(service, input(state)), /optional future/);
  const old = input();
  writeFileSync(report, original.replace('state: clarify', 'state: prototype'));
  assert.throws(() => toggleRoute(service, old), /moved/);
  assert.throws(() => toggleRoute(service, input()), /optional future/);
  assert.equal(readFileSync(join(root, '.issues/factory-ui/runs.json'), 'utf8').includes('future-route-choice'), true);
});

test('future toggles remain available during active progress, reject changed policy and roll back failed persistence', (t) => {
  const { root, service, input } = lifecycleFixture(t);
  service.ownServer();
  service.lifecycleTasks.set('20261026-one', Promise.resolve());
  service.lifecycleRuns['20261026-one'] = { status: 'running', issueId: '20261026-one' };
  toggleRoute(service, input());
  const before = service.store.runs.length,
    save = service.store.save;
  service.store.save = () => {
    throw Error('deliberate disk failure');
  };
  assert.throws(() => toggleRoute(service, input()), /disk failure/);
  assert.equal(service.store.runs.length, before);
  service.store.save = save;
  service.store.reload();
  assert.equal(service.store.runs.at(-1).savedRoutes[0].steps.at(-1).decision, 'skip');
  const old = input('investigate');
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":false}');
  assert.throws(() => toggleRoute(service, old), /route changed/);
  toggleRoute(service, input('commit'));
  service.lifecycleTasks.clear();
});

test('queue squares use recorded outcomes, actual work and input; no historical completion is inferred', (t) => {
  const { service, report } = lifecycleFixture(t);
  const text = readFileSync(report, 'utf8');
  writeFileSync(
    report,
    text.replace('state: clarify', 'state: implement').replace(
      'grill_later: false',
      `grill_later: false
lifecycle_history:
  - state: clarify
    outcome: completed
    reason: Answered the question
    at: '2026-10-26T10:00:00Z'
    evidence: [{path: /fixture/answer.json, sha256: abc}]
  - state: investigate
    outcome: skipped
    reason: Feature request
    at: '2026-10-26T10:00:00Z'
    evidence: [{path: /fixture/routing.json, sha256: def}]`
    )
  );
  const roles = () => queueResponse(service.snapshot(), null).issues[0].queueLifecycle.roles;
  assert.deepEqual(
    roles().map((r) => r.status),
    ['completed', 'skipped', 'unknown', 'idle', 'future', 'future', 'planned-skip', 'planned-skip']
  );
  service.lifecycleRuns['20261026-one'] = { issueId: '20261026-one', status: 'running' };
  service.lifecycleTasks.set('20261026-one', Promise.resolve());
  assert.equal(roles()[3].status, 'working');
  service.lifecycleRuns['20261026-one'] = { issueId: '20261026-one', status: 'waiting', input: { type: 'questions' } };
  assert.equal(roles()[3].status, 'idle');
  assert.equal(roles()[3].action, 'input');
  const run = {
    id: 'error',
    issueId: '20261026-one',
    issueState: 'implement',
    kind: 'worker',
    status: 'blocked',
    events: [],
    summary: 'Actual failure',
  };
  service.store.runs.push(run);
  service.store.save();
  assert.equal(roles()[3].status, 'blocked');
  assert.equal(roles()[3].waiting, true);
  service.lifecycleTasks.clear();
  service.lifecycleRuns = {};
  writeFileSync(report, text.replace('state: clarify', 'state: final'));
  assert.equal(roles()[6].waiting, true);
  assert.equal(roles()[6].status, 'idle');
  assert.equal(roles()[6].action, 'input');
});

test('route HTTP mutation retains local session/origin/manual/preview guards and real persistence', async (t) => {
  const { service, input } = lifecycleFixture(t);
  const server = createFactoryServer(service);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const send = (headers) =>
    fetch(url + '/api/toggle-route', { method: 'POST', headers, body: JSON.stringify(input()) });
  const headers = { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' };
  assert.equal((await send({ ...headers, origin: 'https://elsewhere.invalid' })).status, 400);
  assert.equal((await send({ ...headers, cookie: '' })).status, 400);
  assert.equal((await send({ ...headers, 'x-factory-action': '' })).status, 400);
  assert.equal((await send(headers)).status, 200);
  service.reviewMode = 'preview';
  assert.equal((await send(headers)).status, 400);
  assert.equal(service.store.runs.length, 1);
});
