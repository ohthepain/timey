import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { git } from './factory-ui/common.mjs';
import { createSharedIssueClaims } from './factory-ui/shared-issue-claims.mjs';

const execute = promisify(execFile);
const issueId = '20261111T165430736-ca3555165563420b';
const ref = `refs/heads/claims/${issueId}`;
const report = '---\nstate: backlog\n---\n';
const claimProgram = `
  import { createSharedIssueClaims } from ${JSON.stringify(new URL('./factory-ui/shared-issue-claims.mjs', import.meta.url).href)};
  const claims = createSharedIssueClaims({ root: process.argv[1] });
  const issueId = process.argv[2];
  const result = process.argv[3] === 'release' ? claims.release(claims.own(issueId)) : claims.acquire(issueId);
  process.stdout.write(JSON.stringify(result));
`;

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'shared-issue-claims-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'remote.git');
  const first = join(base, 'first');
  const second = join(base, 'second');
  git(base, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(base, 'clone', '-q', remote, first);
  mkdirSync(join(first, '.issues'));
  writeFileSync(join(first, '.issues', issueId + '.md'), report);
  git(first, 'add', '.issues');
  git(first, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-qm', 'Publish issue');
  git(first, 'push', '-q', 'origin', 'dev');
  git(base, 'clone', '-q', remote, second);
  return { base, remote, first, second };
}

test('two independent clones cannot both claim the same issue', async (t) => {
  const { first, second } = fixture(t);
  const results = await Promise.allSettled(
    [first, second].map((root) => execute(process.execPath, ['--input-type=module', '-e', claimProgram, root, issueId]))
  );
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const [winner, loser] = results[0].status === 'fulfilled' ? [first, second] : [second, first];
  const owner = createSharedIssueClaims({ root: winner });
  const observer = createSharedIssueClaims({ root: loser });
  const claim = owner.verifyOwn(issueId);
  assert.ok(claim);
  assert.equal(observer.own(issueId), null);
  assert.equal(observer.list().get(issueId).oid, claim.oid);
  assert.equal(observer.readTargetReport(issueId), report);
  assert.throws(() => observer.acquire(issueId), /already claims/);

  assert.equal(owner.release(claim), true);
  assert.equal(observer.list().has(issueId), false);
  const next = observer.acquire(issueId);
  assert.notEqual(next.oid, claim.oid);
  assert.throws(() => owner.release(claim), /does not match/);
  assert.equal(observer.verifyOwn(issueId).oid, next.oid);
});

test('reconciling a stale local claim leaves a replacement remote claim intact', (t) => {
  const { remote, first, second } = fixture(t);
  const owner = createSharedIssueClaims({ root: first });
  const observer = createSharedIssueClaims({ root: second });
  const stale = owner.acquire(issueId);
  git(remote, 'update-ref', '-d', ref, stale.oid);
  const replacement = observer.acquire(issueId);
  assert.equal(owner.verifyOwn(issueId), null);
  assert.equal(owner.release(stale), true);
  assert.equal(owner.own(issueId), null);
  assert.equal(owner.list().get(issueId).oid, replacement.oid);
});

test('interrupted creation and release reconcile the exact remote claim', async (t) => {
  const { base, first, second } = fixture(t);
  const wrapper = join(base, 'git');
  writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$3" = push ]; then
  if [ "$TIMEY_TEST_PUSH_FAILURE" = after ]; then
    "$TIMEY_TEST_REAL_GIT" "$@" || exit $?
  fi
  exit 92
fi
exec "$TIMEY_TEST_REAL_GIT" "$@"
`,
    { mode: 0o700 }
  );
  const runWithInterruption = (root, when, operation = 'acquire') =>
    execute(process.execPath, ['--input-type=module', '-e', claimProgram, root, issueId, operation], {
      env: {
        ...process.env,
        PATH: base + ':' + process.env.PATH,
        TIMEY_TEST_REAL_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
        TIMEY_TEST_PUSH_FAILURE: when,
      },
    });
  const owner = createSharedIssueClaims({ root: first });
  await assert.rejects(runWithInterruption(first, 'before'), /Could not confirm remote claim creation/);
  assert.ok(owner.own(issueId));
  assert.equal(owner.verifyOwn(issueId), null);
  assert.throws(() => owner.acquire(issueId), /already has a claim record/);

  const { stdout } = await runWithInterruption(second, 'after');
  const confirmed = JSON.parse(stdout);
  assert.equal(owner.list().get(issueId).oid, confirmed.oid);
  owner.release(owner.own(issueId));
  assert.equal(owner.list().get(issueId).oid, confirmed.oid);
  await assert.rejects(runWithInterruption(second, 'before', 'release'), /Could not release the remote claim/);
  assert.equal(owner.list().get(issueId).oid, confirmed.oid);
  assert.equal((await runWithInterruption(second, 'after', 'release')).stdout, 'true');
  assert.equal(owner.list().has(issueId), false);
  assert.equal(createSharedIssueClaims({ root: second }).own(issueId), null);
});
