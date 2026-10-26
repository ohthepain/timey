import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { factory } from './factory-ledger.mjs';
import { finalizeDelivery, currentDelivery } from './factory-ui/delivery.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { digest } from './factory-ui/common.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { progressBasis } from './factory-ui/next-action.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';

function fixture(t) {
  const queue = gitFixture(t, 'delivery-queue-'),
    source = gitFixture(t, 'delivery-source-');
  for (const repo of [queue, source]) {
    writeFileSync(join(repo.root, '.gitignore'), '.issues/\n');
    writeFileSync(join(repo.root, 'code.js'), 'export const value = 1;\n');
    repo.git('add', '.');
    repo.git('commit', '-qm', 'source');
    mkdirSync(join(repo.root, '.issues'));
  }
  const helper = join(queue.root, '.agents/skills/issues/scripts');
  mkdirSync(helper, { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json'])
    cpSync(resolve('.agents/skills/issues/scripts', name), join(helper, name));
  queue.git('add', '.agents');
  queue.git('commit', '-qm', 'guard');
  writeFileSync(
    join(queue.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(queue.root, '.issues/20261025-one.md'),
    '---\nid: 20261025-one\nstate: verify\n---\nActual issue\n'
  );
  factory(queue.root).init();
  const revision = source.git('rev-parse', 'HEAD'),
    tree = source.git('rev-parse', 'HEAD^{tree}');
  const log = join(source.root, '.issues/audit.log');
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
  const verification = ['verification', 'step'].map((checkpoint) => {
    const path = join(source.root, '.issues/' + checkpoint + '.json');
    const names = checkpoint === 'step' ? ['fallow'] : ['fallow', 'factory', 'typecheck', 'tests', 'build'];
    writeFileSync(
      path,
      JSON.stringify({
        checkpoint,
        base: revision,
        snapshot_tree: tree,
        passed: true,
        changed_files: [],
        checks: names.map((name) => ({ name, passed: true, exit: 0, log })),
      })
    );
    return path;
  });
  const issue = readQueue(queue.root).issues[0];
  const input = {
    operationId: 'delivery-one',
    issueId: issue.id,
    expectedState: issue.state,
    reportDigest: digest(issue.content),
    checkout: source.root,
    revision,
    base: revision,
    verification,
    requirements: [
      { description: 'Reviewed delivered behavior', evidence: [{ path: log, sha256: digest(readFileSync(log)) }] },
    ],
    authorization: { path: log, sha256: digest(readFileSync(log)) },
  };
  return { queue, source, input };
}
test('separate-source delivery advances actual issue once and preserves verification, commit and integration', (t) => {
  const { queue, source, input } = fixture(t);
  const before = queue.git('rev-parse', 'HEAD');
  assert.equal(finalizeDelivery(queue.root, input).state, 'final');
  let issue = readQueue(queue.root).issues[0];
  assert.deepEqual(
    issue.lifecycle_history.map((s) => [s.state, s.outcome]),
    [
      ['verify', 'completed'],
      ['commit', 'completed'],
      ['@integration', 'completed'],
    ]
  );
  assert.equal(issue.delivery.revision, input.revision);
  assert.equal(queue.git('rev-parse', 'HEAD'), before);
  assert.equal(currentDelivery(issue).checkout, realpathSync(source.root));
  assert.equal(finalizeDelivery(queue.root, input).repeated, true);
  issue = readQueue(queue.root).issues[0];
  assert.equal(issue.lifecycle_history.length, 3);
  assert.equal(issue.state, 'final');
  writeFileSync(join(source.root, 'code.js'), 'changed\n');
  assert.throws(() => currentDelivery(issue), /uncommitted/);
});
test('failed evidence and stale report leave the issue unchanged', (t) => {
  const { queue, input } = fixture(t),
    file = join(queue.root, '.issues/20261025-one.md'),
    before = readFileSync(file, 'utf8');
  assert.throws(
    () => finalizeDelivery(queue.root, { ...input, verification: input.verification.slice(1) }),
    /Full verification/
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => finalizeDelivery(queue.root, { ...input, reportDigest: 'stale' }), /issue changed/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('an interrupted prepared delivery resumes without repeating software work', (t) => {
  const { queue, input } = fixture(t);
  const file = join(queue.root, '.issues/20261025-one.md'),
    before = readFileSync(file, 'utf8');
  finalizeDelivery(queue.root, input);
  // Simulate a retained prepared receipt with the issue rename still outstanding.
  writeFileSync(file, before);
  input.verification.forEach(unlinkSync);
  assert.equal(finalizeDelivery(queue.root, input).state, 'final');
  assert.throws(() => finalizeDelivery(queue.root, { ...input, revision: '0'.repeat(40) }), /different delivery/);
});
test('queue polling excludes transcripts and bounds selected live output without changing retained history', () => {
  const run = {
    id: 'run',
    issueId: 'one',
    events: [{ text: 'x'.repeat(2000000) }],
    instructions: 'x'.repeat(1000000),
    output: Array.from({ length: 40 }, () => ({ text: 'x'.repeat(100000) })),
  };
  const snapshot = { actions: [], runs: [run] };
  assert.ok(JSON.stringify(queueResponse(snapshot, 'one')).length < 17000);
  assert.ok(JSON.stringify(queueResponse(snapshot, null)).length < 1000);
  assert.equal(run.events[0].text.length, 2000000);
  assert.equal(run.output.length, 40);
});

test('finalized separate-source delivery closes only on an explicit decision', (t) => {
  const { queue, source, input } = fixture(t);
  finalizeDelivery(queue.root, input);
  writeFileSync(join(source.root, 'later.js'), 'another issue\n');
  source.git('add', 'later.js');
  source.git('commit', '-qm', 'later unrelated work');
  writeFileSync(join(source.root, 'code.js'), 'uncommitted later source\n');
  const service = new FactoryUI(queue.root);
  t.after(() => service.close());
  let snapshot = readQueue(queue.root);
  assert.equal(snapshot.issues[0].state, 'final');
  service.decideIssue(input.issueId, 'final', 'close', progressBasis(snapshot));
  snapshot = readQueue(queue.root);
  assert.equal(snapshot.issues[0].state, 'closed');
  assert.equal(snapshot.issues[0].accepted_result.revision, input.revision);
  assert.equal(snapshot.issues[0].accepted_result.verification_rerun, false);
});
test('delivery preserves a required custom stage instead of skipping it', (t) => {
  const { queue, input } = fixture(t);
  const file = join(queue.root, '.issues/triage-labels.md');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('| verify | commit |', '| verify | qa |') +
      '| custom | qa | commit | Required QA |\n'
  );
  assert.throws(() => finalizeDelivery(queue.root, input), /custom stage/);
  assert.equal(readQueue(queue.root).issues[0].state, 'verify');
});
