import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { digest } from './factory-ui/common.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { retroProof } from './factory-ui/flow-retro-proof.mjs';
import { appendMessage } from './factory-ui/conversation-store.mjs';
import { deliveryFixture } from './factory-workflow-fixture.mjs';

test('Retro supplies only bounded digest-verified allowlisted proof and preserves attempt origins', (t) => {
  const f = deliveryFixture(t);
  const evidence = join(f.queue.root, '.issues/evidence');
  mkdirSync(evidence, { recursive: true });
  const retained = join(evidence, 'verified.log');
  const partial = join(evidence, 'partial.log');
  const missing = join(evidence, 'missing.log');
  const changed = join(evidence, 'changed.log');
  writeFileSync(
    retained,
    'Established: dirty checkout rejected; cache reused after an unchanged-tree commit; content change invalidated reuse. password=secret-value\n'
  );
  writeFileSync(
    partial,
    'Established: recovery succeeded on attempt three. Unverified: behavior after a third failure.\n'
  );
  writeFileSync(changed, 'current bytes differ from the recorded proof.\n');
  const refs = [
    { path: retained, sha256: digest(readFileSync(retained)), attemptId: 'attempt-134' },
    { path: partial, sha256: digest(readFileSync(partial)), attemptId: 'attempt-135' },
    { path: missing, sha256: 'a'.repeat(64), attemptId: 'attempt-135' },
    { path: changed, sha256: 'b'.repeat(64), attemptId: 'attempt-135' },
  ];
  appendMessage(f.queue.root, f.input.issueId, {
    id: 'proof-source',
    actor: 'factory',
    role: 'Factory',
    kind: 'stage-outcome',
    at: new Date().toISOString(),
    body: 'Stage outcome evidence references these retained artifacts.',
    source: { evidence: refs },
  });
  const service = {
    root: f.queue.root,
    store: { directory: join(f.queue.root, '.issues/factory-ui'), runs: [] },
    lifecycleRuns: {},
  };
  const proof = retroProof(service, f.input.issueId);
  assert.deepEqual(
    proof.map((entry) => entry.status),
    ['verified', 'verified', 'missing', 'digest-mismatch']
  );
  assert.match(proof[0].excerpt, /Established: dirty checkout rejected/);
  assert.match(proof[0].excerpt, /content change invalidated reuse/);
  assert.doesNotMatch(proof[0].excerpt, /secret-value/);
  assert.equal(proof[0].origins[0].attemptId, 'attempt-134');
  assert.match(proof[1].excerpt, /Unverified: behavior after a third failure/);
  assert.equal(proof[1].origins[0].attemptId, 'attempt-135');
  assert.equal(proof[2].excerpt, undefined);
  assert.equal(proof[3].excerpt, undefined);
  assert.ok(proof[0].excerpt.length <= 1800);
});
