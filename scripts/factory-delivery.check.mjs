import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { finalizeDelivery, currentDelivery } from './factory-ui/delivery.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { progressBasis } from './factory-ui/next-action.mjs';
import { queueResponse } from './factory-ui/queue-response.mjs';

test('separate-source delivery advances actual issue once and preserves verification, commit and integration', (t) => {
  const { queue, source, input } = deliveryFixture(t);
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
  const { queue, input } = deliveryFixture(t),
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
  const { queue, input } = deliveryFixture(t);
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
  const { queue, source, input } = deliveryFixture(t);
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
  const { queue, input } = deliveryFixture(t);
  const file = join(queue.root, '.issues/triage-labels.md');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('| verify | commit |', '| verify | qa |') +
      '| custom | qa | commit | Required QA |\n'
  );
  assert.throws(() => finalizeDelivery(queue.root, input), /custom stage/);
  assert.equal(readQueue(queue.root).issues[0].state, 'verify');
});
