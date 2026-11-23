import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';

const report = (id, state = 'needs-approval') =>
  `---\nid: ${id}\ntitle: Approval fixture\nstate: ${state}\n---\nOriginal request.\n`;

async function fixture(t, { kind = 'files', separate = false, trace = false } = {}) {
  const base = gitFixture(t, 'atomic-publication-');
  writeFileSync(join(base.root, '.gitignore'), '.issues/\n');
  writeFileSync(join(base.root, 'source.txt'), 'Source.\n');
  base.git('add', '.');
  base.git('commit', '-qm', 'Source');
  if (kind === 'git') {
    const remote = join(base.root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    base.git('remote', 'add', 'origin', remote);
  }
  if (trace) {
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = join(base.root, 'atomic.trace');
    t.after(() => {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
    });
  }
  const options = { root: base.root, projectId: 'atomic-fixture' };
  const artifacts = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  const config = { id: 'shared', kind, branch: 'issue-queue' };
  const records = await openRecordStore(config, { ...options, artifacts });
  const issueId = separate ? 'other' : config.id;
  const provider = await openIssueStore({ ...config, id: issueId }, { ...options, artifacts });
  const project = createProjectStores({
    ...options,
    records,
    issueStores: new Map([[issueId, provider]]),
    artifacts,
    runnerId: 'runner',
  });
  const id = '20261123-approval';
  await project.importIssue({
    id,
    storeId: issueId,
    artifactStoreId: artifacts.id,
    report: report(id),
    flow: { version: 1, issueId: id, revision: 1, blocks: [] },
    operationId: 'import',
  });
  const current = await project.readIssue(id);
  const input = {
    issueId: id,
    report: report(id, 'backlog'),
    expectedRevision: current.revision,
    operationId: 'approve',
  };
  return { ...base, records, provider, project, id, current, input };
}

test('same-store approval commits report, history and confirmation in one Git transaction', async (t) => {
  const f = await fixture(t, { kind: 'git', trace: true });
  const before = f.git('rev-parse', 'refs/remotes/origin/issue-queue');
  const trace = join(f.root, 'atomic.trace');
  const previousEvents = readFileSync(trace, 'utf8').trim().split('\n').length;
  const result = await f.project.saveIssue(f.input);
  const commands = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .slice(previousEvents)
    .map(JSON.parse)
    .filter((event) => event.event === 'start' && event.argv[0] === 'git');
  const headChecks = commands.filter((event) => event.argv.includes('ls-remote')).length;
  assert.equal(headChecks, 4, 'Approval uses one read phase and one checked transaction.');
  t.diagnostic(`Atomic approval used ${headChecks} remote head checks and one durable commit.`);
  const after = f.git('ls-remote', '--heads', 'origin', 'refs/heads/issue-queue').split(/\s/)[0];
  assert.equal(
    Number(f.git('rev-list', '--count', `${before}..${after}`)),
    1,
    'Approval needs one checked durable transaction.'
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(result.report, f.input.report);
  assert.equal(result.issue.report.toString(), f.input.report);
  assert.equal((await f.provider.history(f.id)).length, 2);
  assert.equal((await f.records.get('operations/approve')).value.status, 'confirmed');
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.equal((await f.project.readIssue(f.id)).report, f.input.report);
  const replay = await f.project.saveIssue(f.input);
  assert.equal(replay.revision, result.revision);
  await assert.rejects(f.project.saveIssue({ ...f.input, report: f.input.report + 'Changed.' }), {
    code: 'STORE_OPERATION_MISMATCH',
  });
});

test('atomic approval rejects a busy claim without leaving a publication operation', async (t) => {
  const f = await fixture(t);
  await f.records.commit({
    operationId: 'busy',
    expected: [{ key: 'claims/' + f.id, revision: null }],
    writes: [{ key: 'claims/' + f.id, value: { token: 'other', runnerId: 'other', attemptId: 'other' } }],
  });
  await assert.rejects(f.project.saveIssue(f.input), { code: 'STORE_CLAIMED' });
  assert.equal(await f.records.get('operations/approve'), null);
  assert.equal((await f.provider.read(f.id)).report.toString(), report(f.id));
});

test('atomic approval keeps migration, stale report and merged-flow guards', async (t) => {
  for (const gate of ['migration', 'report', 'merged']) {
    const f = await fixture(t);
    if (gate === 'migration')
      await f.records.commit({
        operationId: 'seal',
        expected: [{ key: 'project/migration', revision: null }],
        writes: [{ key: 'project/migration', value: { token: 'seal', state: 'sealed' } }],
      });
    if (gate === 'report')
      await f.provider.commit({
        issueId: f.id,
        expectedRevision: f.current.revision,
        report: report(f.id) + 'Peer.',
        location: 'open',
        operationId: 'peer',
      });
    if (gate === 'merged') {
      const flow = await f.records.get('flows/' + f.id);
      await f.records.commit({
        operationId: 'merged',
        expected: [{ key: flow.key, revision: flow.revision }],
        writes: [{ key: flow.key, value: { ...flow.value, merged: { revision: 'peer' } } }],
      });
    }
    await assert.rejects(f.project.saveIssue(f.input), {
      code: gate === 'migration' ? 'STORE_MIGRATING' : gate === 'report' ? 'STORE_CONFLICT' : 'STORE_MERGED',
    });
    assert.equal(await f.records.get('operations/approve'), null);
  }
});

test('concurrent atomic approvals allow one publication and preserve the losing input', async (t) => {
  const f = await fixture(t);
  const inputs = [f.input, { ...f.input, operationId: 'other-approval', report: f.input.report + 'Other.' }];
  const outcomes = await Promise.allSettled(inputs.map((input) => f.project.saveIssue(input)));
  const winner = outcomes.findIndex((entry) => entry.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal((await f.project.readIssue(f.id)).report, inputs[winner].report);
  assert.equal(await f.records.get('operations/' + inputs[1 - winner].operationId), null);
  assert.equal(await f.records.get('claims/' + f.id), null);
});

test('atomic publication checks catalog, flow, claim and migration revisions at commit', async (t) => {
  for (const changed of ['catalog', 'flows', 'claims', 'project/migration']) {
    const f = await fixture(t);
    const commit = f.provider.commit.bind(f.provider);
    f.provider.commit = async (input) => {
      assert.ok(input.coordination);
      const key = changed === 'project/migration' ? changed : changed + '/' + f.id;
      const previous = await f.records.get(key);
      const value =
        changed === 'catalog'
          ? { ...previous.value, epoch: 'peer-move' }
          : changed === 'flows'
            ? { ...previous.value, revision: 2, merged: { revision: 'peer' } }
            : changed === 'claims'
              ? { token: 'peer', attemptId: 'peer', runnerId: 'peer' }
              : { token: 'peer', state: 'sealed' };
      await f.records.commit({
        operationId: 'peer-race',
        expected: [{ key, revision: previous?.revision ?? null }],
        writes: [{ key, value }],
      });
      return commit(input);
    };
    await assert.rejects(f.project.saveIssue(f.input), { code: 'STORE_CONFLICT' });
    assert.equal(await f.records.get('operations/approve'), null);
    assert.equal((await f.provider.read(f.id)).report.toString(), report(f.id));
  }
});

test('confirmed atomic publication returns committed data without a subsequent issue read', async (t) => {
  const f = await fixture(t);
  const commit = f.provider.commit.bind(f.provider);
  f.provider.commit = async (input) => {
    const result = await commit(input);
    f.provider.read = () => {
      throw Error('Read unavailable after confirmation.');
    };
    return result;
  };
  const result = await f.project.saveIssue(f.input);
  assert.equal(result.report, f.input.report);
  assert.equal(result.issue.report.toString(), f.input.report);
  assert.equal(result.revision, result.issue.revision);
});

test('lost committed reply reconciles the original atomic operation and replay stays idempotent', async (t) => {
  const f = await fixture(t);
  const commit = f.provider.commit.bind(f.provider);
  let writes = 0;
  f.provider.commit = async (input) => {
    writes++;
    await commit(input);
    throw Object.assign(Error('Committed reply lost.'), { code: 'STORE_UNAVAILABLE' });
  };
  const result = await f.project.saveIssue(f.input);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.report, f.input.report);
  assert.equal(writes, 1);
  await f.project.saveIssue(f.input);
  assert.equal(writes, 1);
  assert.equal((await f.provider.history(f.id)).length, 2);
});

test('an uncertain atomic dispatch never falls through the legacy journal', async (t) => {
  const f = await fixture(t);
  const commit = f.provider.commit.bind(f.provider);
  let dispatched = 0;
  f.provider.commit = async () => {
    dispatched++;
    throw Object.assign(Error('Transport interrupted.'), { code: 'STORE_UNAVAILABLE' });
  };
  await assert.rejects(
    f.project.saveIssue(f.input),
    (error) => error.pending === true && error.operationId === 'approve'
  );
  assert.equal(dispatched, 1);
  assert.equal(await f.records.get('operations/approve'), null);
  assert.equal(await f.records.get('claims/' + f.id), null);
  f.provider.commit = commit;
  assert.equal((await f.project.saveIssue(f.input)).status, 'confirmed');
});

test('legacy pending publications and separate stores retain the existing journal protocol', async (t) => {
  for (const separate of [false, true]) {
    const f = await fixture(t, { separate });
    if (!separate)
      await f.project.coordination.operation(
        'approve',
        'save-issue',
        {
          issueId: f.id,
          report: f.input.report,
          location: 'open',
          expectedRevision: f.input.expectedRevision,
          storeId: f.current.storeId,
          homeEpoch: f.current.homeEpoch,
          kind: 'edit',
          owner: null,
        },
        { claimAdmission: true }
      );
    const commit = f.provider.commit.bind(f.provider);
    f.provider.commit = async (input) => {
      assert.equal(input.coordination, undefined);
      return commit(input);
    };
    assert.equal((await f.project.saveIssue(f.input)).status, 'confirmed');
    assert.equal((await f.records.get('operations/approve')).value.status, 'confirmed');
    assert.equal(await f.records.get('claims/' + f.id), null);
  }
});

test('coordinated publication cannot overwrite Issue keys or duplicate checked records', async (t) => {
  const f = await fixture(t);
  for (const coordination of [
    { expected: [{ key: 'issues/' + f.id + '/head', revision: f.current.revision }], writes: [] },
    {
      expected: [
        { key: 'guard', revision: null },
        { key: 'guard', revision: null },
      ],
      writes: [],
    },
  ]) {
    await assert.rejects(f.provider.commit({ ...f.input, location: 'open', coordination }), { code: 'STORE_INVALID' });
  }
  assert.equal((await f.provider.read(f.id)).report.toString(), report(f.id));
});

test('owner-backed publications keep their exact existing claim and generic protocol', async (t) => {
  const f = await fixture(t);
  const operation = await f.project.coordination.operation('work', 'work', {});
  const owner = f.project.coordination.owner(operation, f.id);
  await f.project.coordination.acquire(owner, 'work-claim');
  const commit = f.provider.commit.bind(f.provider);
  f.provider.commit = async (input) => {
    assert.equal(input.coordination, undefined);
    return commit(input);
  };
  assert.equal((await f.project.saveIssue({ ...f.input, owner })).status, 'confirmed');
  assert.equal((await f.records.get('claims/' + f.id)).value.token, owner.token);
});
