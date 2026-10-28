import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageWorkerArtifacts, completionArtifacts } from './factory-ui/evidence-staging.mjs';
import { proof } from './issue-delivery-store.mjs';

test('declared artifacts survive temporary worker cleanup and remain bound to contribution', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'stage-root-')),
    temp = mkdtempSync(join(tmpdir(), 'stage-worker-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });
  const path = join(temp, 'browser.log');
  writeFileSync(path, 'actual browser evidence');
  const action = { id: 'action', issues: ['issue'], basis: { head: 'a'.repeat(40) } };
  const checked = { head: 'b'.repeat(40), tree: 'c'.repeat(40) };
  const index = stageWorkerArtifacts(root, action, checked, [proof(path)]);
  assert.deepEqual(stageWorkerArtifacts(root, action, checked, [proof(path)]), index);
  const review = join(root, 'review.json');
  writeFileSync(
    review,
    JSON.stringify({ action: { ...action, evidence: JSON.stringify({ retainedArtifacts: index }) } })
  );
  const delivery = {
    contributions: [
      {
        actionId: 'action',
        issues: ['issue'],
        workerRevision: checked.head,
        originalBase: action.basis.head,
        receipt: proof(review),
        evidence: [],
      },
    ],
  };
  // Native assembly stores the selected review in its receipt.
  const receipt = join(root, 'assembly.json');
  writeFileSync(receipt, JSON.stringify({ review: proof(review) }));
  delivery.contributions[0].receipt = proof(receipt);
  rmSync(temp, { recursive: true });
  const retained = completionArtifacts(root, delivery);
  assert.equal(readFileSync(retained.get(path).path, 'utf8'), 'actual browser evidence');
  delivery.contributions[0].workerRevision = 'd'.repeat(40);
  assert.throws(() => completionArtifacts(root, delivery), /candidate|contribution/);
});

test('missing, changed, symlinked and unbounded artifacts fail with the specific path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'stage-reject-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'proof.log');
  writeFileSync(path, 'original');
  const declared = proof(path);
  writeFileSync(path, 'changed');
  const action = { id: 'a', issues: ['i'], basis: { head: 'a'.repeat(40) } },
    checked = { head: 'b'.repeat(40), tree: 'c'.repeat(40) };
  assert.throws(() => stageWorkerArtifacts(root, action, checked, [declared]), /proof.log/);
  const link = join(root, 'link');
  symlinkSync(path, link);
  assert.throws(() => stageWorkerArtifacts(root, action, checked, [proof(link)]), /symlink/i);
  assert.throws(() => stageWorkerArtifacts(root, action, checked, Array(129).fill(proof(path))), /128/);
});

test('transport phase diagnostics retain timings without prompts or credentials', async () => {
  const { CodexConnection } = await import('./factory-ui/codex.mjs');
  const connection = new CodexConnection();
  connection.send = (value) =>
    queueMicrotask(() => connection.reply({ id: value.id, result: { secret: 'provider-secret' } }));
  await connection.call('thread/read', { threadId: 'chat', prompt: 'private-prompt', token: 'private-token' });
  assert.deepEqual(
    connection.phases.map((p) => p.phase),
    ['requested', 'replied']
  );
  assert.ok(connection.phases.every((p) => p.at && p.threadId === 'chat'));
  assert.doesNotMatch(JSON.stringify(connection.phases), /private|provider-secret/);
  connection.close();
});

test('captured policy changes are diagnosed without exposing file contents', async (t) => {
  const { gitFixture } = await import('./git-fixture.mjs');
  const { captureInputs, assertCurrentInputs } = await import('./factory-ui/input-change.mjs');
  const { root } = gitFixture(t, 'input-policy-');
  const path = join(root, 'AGENTS.md');
  writeFileSync(path, 'Original private instructions.');
  const queue = {
    root,
    snapshot: { head: 'head', worktree: 'clean' },
    issues: [{ id: 'issue', content: 'Selected issue' }],
    actions: [],
  };
  const captured = captureInputs(queue, 'issue');
  writeFileSync(path, 'Changed private instructions.');
  assert.throws(
    () => assertCurrentInputs(captured, queue, 'issue', 'Inputs changed.'),
    (error) => {
      assert.deepEqual(error.recovery.changedInputs, ['files:AGENTS.md']);
      assert.doesNotMatch(JSON.stringify(error.recovery), /private instructions/);
      return true;
    }
  );
});

test('concurrent candidate checks share one run and reject a conflicting base', async (t) => {
  const { gitFixture } = await import('./git-fixture.mjs');
  const { fixtureDeliveryCheck } = await import('./issue-delivery-fixture.mjs');
  const { checkCandidate } = await import('./factory-ui/checks.mjs');
  const { realpathSync, mkdirSync } = await import('node:fs');
  const fixture = gitFixture(t, 'candidate-concurrency-');
  const root = realpathSync(fixture.root),
    git = fixture.git;
  writeFileSync(join(root, '.gitignore'), '.issues/\nnode_modules/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'second comparison base');
  mkdirSync(join(root, 'node_modules'));
  const folder = join(root, '.issues/evidence');
  const checked = await fixtureDeliveryCheck(root, base, folder);
  const bin = join(root, '.issues/bin');
  mkdirSync(bin);
  const calls = join(root, '.issues/calls');
  // Protocol fixture only: these synthetic summaries never establish application success.
  writeFileSync(
    join(bin, 'pnpm'),
    '#!' +
      process.execPath +
      '\n' +
      `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');setTimeout(()=>console.log('Verification summary: '+${JSON.stringify(folder)}+'/'+(process.argv.includes('verify')?'verification':'step')+'.json'),150);\n`,
    { mode: 0o755 }
  );
  const priorPath = process.env.PATH;
  process.env.PATH = bin + ':' + priorPath;
  try {
    const first = checkCandidate(root, base, join(root, '.issues/check-one'));
    const second = checkCandidate(root, base, join(root, '.issues/check-two'));
    await assert.rejects(checkCandidate(root, 'HEAD', join(root, '.issues/conflict')), /already running/);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
    assert.equal(a.tree, checked.tree);
  } finally {
    process.env.PATH = priorPath;
  }
});
