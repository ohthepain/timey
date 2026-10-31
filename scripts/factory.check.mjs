import { issueInputs, issueContext } from './factory-inputs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './factory.mjs';
import { gitFixture } from './git-fixture.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'factory-check-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.js'), 'export const answer = 42;\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  writeFileSync(join(root, '.issues/triage-labels.md'), '| Role | State | Next |\n| closed | closed | — |\n');
  for (const id of ['one', 'two']) {
    writeFileSync(
      join(root, `.issues/20261022-${id}.md`),
      `---\nid: ${id}\nstate: in-progress\ngrill_later: false\n---\nFixture\n`
    );
  }
  const api = factory(root);
  api.init();
  const proposal = (issues = ['one']) => ({
    kind: 'implement',
    title: 'Fixture',
    scope: 'Bounded fixture',
    reason: 'Exercise invariant',
    verification: 'Relevant tests',
    worker_prompt: 'Work only on the fixture.',
    merge: 'human-first',
    dependencies: [],
    issues,
  });
  return { root, git, api, proposal };
}

test('planning is inert; manual reservation is exclusive across overlapping actions', (t) => {
  const { api, proposal } = fixture(t);
  const [first, duplicate, independent] = api.recommend([proposal(), proposal(), proposal(['two'])]);
  assert.deepEqual(
    api.inspect().registry.actions.map((a) => a.status),
    ['recommended', 'recommended', 'recommended']
  );
  api.reserve(first.id);
  assert.throws(() => api.reserve(first.id), /never dispatch it twice/);
  assert.throws(() => api.reserve(duplicate.id), /already claimed/);
  assert.equal(api.reserve(independent.id).status, 'reserved');
  api.attach(first.id, { clientThreadId: 'pending' });
  assert.equal(api.inspect().registry.actions[0].status, 'setup');
  api.attach(first.id, { threadId: 'ready', hostId: 'local', issues: ['two'] });
  assert.deepEqual(api.inspect().registry.actions[0].issues, ['one']);
  assert.throws(() => api.attach(first.id, { threadId: 'again', hostId: 'local' }), /unbound/);
});

test('issue inputs track transitive dependencies, action dependencies, linked plans and policy', (t) => {
  const { root, api } = fixture(t);
  const snapshot = api.inspect().snapshot;
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  const plan = join(root, 'docs/plans/implementation.md');
  writeFileSync(plan, '# Approved plan');
  const reports = [
    { id: 'one', content: '# One\n[Plan](docs/plans/implementation.md)\n## Blocked by\ntwo' },
    { id: 'two', content: '# Two\n## Blocked by\nthree' },
    { id: 'three', content: '# Three' },
    { id: 'other', content: '# Independent' },
  ];
  const actions = [
    { id: 'selected', issues: ['one'], dependencies: ['prerequisite'], status: 'blocked' },
    { id: 'prerequisite', issues: ['three'], dependencies: [], status: 'completed' },
    { id: 'other-action', issues: ['other'], dependencies: [], status: 'running' },
  ];
  const key = () => issueInputs(root, snapshot, reports, actions, ['one']);
  const original = key();
  const context = issueContext({ issues: reports, actions }, 'one');
  assert.deepEqual(
    context.issues.map((r) => r.id),
    ['one', 'two', 'three']
  );
  assert.equal(
    context.actions.some((a) => a.id === 'other-action'),
    false
  );
  reports[3].content += ' changed';
  actions[2].status = 'completed';
  reports.reverse();
  actions.reverse();
  assert.equal(key(), original);
  const prerequisite = actions.find((a) => a.id === 'prerequisite');
  prerequisite.status = 'blocked';
  assert.notEqual(key(), original);
  prerequisite.status = 'completed';
  reports.find((r) => r.id === 'three').content += ' changed';
  const dependencyChanged = key();
  assert.notEqual(dependencyChanged, original);
  writeFileSync(plan, '# Changed approval requirements');
  const planChanged = key();
  assert.notEqual(planChanged, dependencyChanged);
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":false}');
  assert.notEqual(key(), planChanged);
});

test('unrelated report changes do not invalidate an independent saved assignment', (t) => {
  const { root, api, proposal } = fixture(t);
  const [action] = api.recommend([proposal()]);
  writeFileSync(join(root, '.issues/20261022-two.md'), '---\nid: two\nstate: closed\n---\nUnrelated completion');
  assert.equal(api.reserve(action.id).status, 'reserved');
});

test('stale queue and committed changes invalidate recommendations', (t) => {
  const { root, git, api, proposal } = fixture(t);
  const [action] = api.recommend([proposal()]);
  writeFileSync(join(root, '.issues/20261022-one.md'), '---\nid: one\nstate: closed\n---\n');
  assert.throws(() => api.reserve(action.id), /Stale/);
  const [other] = api.recommend([proposal(['two'])]);
  writeFileSync(join(root, 'source.js'), 'export const answer = 43;\n');
  git('add', '.');
  git('commit', '-qm', 'changed');
  assert.throws(() => api.reserve(other.id), /Stale/);
});

test('human evidence and judgment can coexist; checks blocking work prevent implementation', (t) => {
  const { root, api, proposal } = fixture(t);
  const path = join(root, '.issues/20261022-one.md');
  writeFileSync(
    path,
    `---\nid: one\nstate: in-progress\ntriage_role: ready-for-agent\nhuman_checks:\n  - id: hardware\n    kind: evidence\n    instructions: Check device timing.\n    blocks: dependent-work\n    status: pending\n  - id: taste\n    kind: judgment\n    instructions: Review integrated workflow.\n    blocks: closure\n    status: pending\n---\n`
  );
  const [action] = api.recommend([proposal()]);
  assert.throws(() => api.reserve(action.id), /human check blocks/);
  assert.equal(api.inspect().reports[0].metadata.triage_role, 'ready-for-agent');
  assert.equal(api.inspect().reports[0].metadata.human_checks.length, 2);
  assert.match(readFileSync(path, 'utf8'), /state: in-progress/);
});

test('worker completion does not close issues or establish integration', (t) => {
  const { root, git, api, proposal } = fixture(t);
  const [action] = api.recommend([{ ...proposal(), merge: 'automatic' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'worker', hostId: 'local' });
  api.record(action.id, {
    status: 'completed',
    evidence: 'Worker report: checks passed in isolation.',
    worker_revision: git('rev-parse', 'HEAD'),
  });
  for (const checks_passed of [false, true])
    assert.throws(
      () =>
        api.record(action.id, {
          status: 'integrated',
          evidence: 'Caller assertion cannot replace PR proof.',
          verified_revision: git('rev-parse', 'HEAD'),
          checks_passed,
        }),
      /Invalid action transition/
    );
  assert.match(readFileSync(join(root, '.issues/20261022-one.md'), 'utf8'), /state: in-progress/);
});

test('missing registry, stale locks, and registry reinitialization fail closed', (t) => {
  const { root, api, proposal } = fixture(t);
  assert.throws(() => api.init(), /EEXIST/);
  mkdirSync(join(root, '.issues/factory.lock'));
  assert.throws(() => api.recommend([proposal()]), /lock exists/);
  rmSync(join(root, '.issues/factory.lock'), { recursive: true });
  rmSync(join(root, '.issues/factory.json'));
  assert.equal(api.inspect().registry, null);
  assert.throws(() => api.recommend([proposal()]), /Registry missing/);
});

test('uncertain setup can recover its original chat without a second reservation', (t) => {
  const { api, proposal } = fixture(t);
  const [action] = api.recommend([proposal()]);
  api.reserve(action.id);
  api.attach(action.id, { clientThreadId: 'original-setup' });
  api.record(action.id, { status: 'blocked', evidence: 'Setup result temporarily unavailable.' });
  assert.equal(api.attach(action.id, { threadId: 'recovered-original', hostId: 'local' }).status, 'running');
  assert.throws(() => api.reserve(action.id), /never dispatch it twice/);
});

test('completed work permits explicit downstream review; merge policy remains enforced', (t) => {
  const { api, git, proposal } = fixture(t);
  const [implementation] = api.recommend([{ ...proposal(), merge: 'human-first' }]);
  api.reserve(implementation.id);
  api.attach(implementation.id, { threadId: 'worker', hostId: 'local' });
  api.record(implementation.id, {
    status: 'completed',
    evidence: 'Worker result available.',
    worker_revision: git('rev-parse', 'HEAD'),
  });
  const [review] = api.recommend([{ ...proposal(), kind: 'review', dependencies: [implementation.id] }]);
  assert.equal(api.reserve(review.id).status, 'reserved');
  assert.throws(
    () => api.record(implementation.id, { status: 'reconciled', evidence: 'Code not integrated.' }),
    /require integrated/
  );
  const update = {
    status: 'integrated',
    evidence: 'Combined revision checked; actual approval linked.',
    verified_revision: git('rev-parse', 'HEAD'),
    checks_passed: true,
  };
  assert.throws(() => api.record(implementation.id, update), /Invalid action transition/);
  assert.throws(() => api.record(implementation.id, { ...update, human_approved: true }), /Invalid action transition/);
});

test('missing registry recovery restores known worker IDs and overlapping claims', (t) => {
  const { root, api, proposal } = fixture(t);
  rmSync(join(root, '.issues/factory.json'));
  api.recover([
    {
      id: 'known-action',
      kind: 'implement',
      status: 'running',
      issues: ['one'],
      merge: 'human-first',
      threadId: 'known-worker',
      hostId: 'local',
      recovery_evidence: 'Existing chat snapshot and approved scope.',
    },
  ]);
  assert.equal(api.inspect().registry.actions[0].threadId, 'known-worker');
  const [candidate] = api.recommend([proposal()]);
  assert.throws(() => api.reserve(candidate.id), /already claimed/);
  assert.throws(() => api.recover([]), /Registry exists/);
});

test('a passed-check assertion cannot integrate a worker commit absent from target history', (t) => {
  const { git, api, proposal } = fixture(t);
  const [action] = api.recommend([{ ...proposal(), merge: 'automatic' }]);
  api.reserve(action.id);
  api.attach(action.id, { threadId: 'worker', hostId: 'local' });
  const unrelated = git('commit-tree', git('write-tree'), '-m', 'independent worker root');
  api.record(action.id, { status: 'completed', evidence: 'Worker branch result.', worker_revision: unrelated });
  assert.throws(() =>
    api.record(action.id, {
      status: 'integrated',
      evidence: 'Claimed target checks.',
      verified_revision: git('rev-parse', 'HEAD'),
      checks_passed: true,
    })
  );
  assert.equal(api.inspect().registry.actions[0].status, 'completed');
});

test('code recommendations and recovery cannot enter non-integratable states', (t) => {
  const { root, api, proposal } = fixture(t);
  assert.throws(() => api.recommend([{ ...proposal(), merge: 'none' }]), /integration policy/);
  rmSync(join(root, '.issues/factory.json'));
  assert.throws(
    () =>
      api.recover([
        {
          id: 'lost',
          kind: 'implement',
          status: 'completed',
          issues: ['one'],
          merge: 'automatic',
          recovery_evidence: 'Found original chat.',
        },
      ]),
    /exact worker commit/
  );
});
