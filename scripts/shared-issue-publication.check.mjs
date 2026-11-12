import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSharedIssuePublication } from './factory-ui/shared-issue-publication.mjs';

const issueId = '20261111T165430736-ca3555165563420b';
const reportPath = `.issues/${issueId}.md`;
const config = { remote: 'origin', target: 'dev', repository: 'example/timey' };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'timey-shared-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, 'origin.git');
  git(directory, 'init', '--bare', remote);
  const root = join(directory, 'runner');
  mkdirSync(root);
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Runner');
  git(root, 'config', 'user.email', 'runner@example.test');
  git(root, 'remote', 'add', 'origin', remote);
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'Seed dev');
  git(root, 'push', 'origin', 'dev');
  return { directory, root, remote };
}

test('queue checkpoint only updates report and number files in a review branch', (t) => {
  const { directory, root, remote } = fixture(t);
  const dev = git(root, 'rev-parse', 'HEAD');
  const requests = [];
  const publication = createSharedIssuePublication({
    root,
    ...config,
    openPullRequest(record) {
      requests.push(record);
      return { number: 1, url: 'https://example.test/queue/1' };
    },
  });
  const base = publication.readTarget(issueId);
  writeFileSync(join(root, 'app.txt'), 'local staged code\n');
  git(root, 'add', 'app.txt');
  mkdirSync(join(root, '.issues', 'issue-work'), { recursive: true });
  writeFileSync(join(root, '.issues', 'issue-work', 'run.txt'), 'local run\n');
  const report = '# First report\n';
  const pending = publication.publish({ issueId, base, report, reason: 'created' });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].commit, pending.commit);
  assert.equal(publication.inspect(issueId).status, 'pending');
  assert.equal(git(root, 'rev-parse', 'HEAD'), dev);
  assert.equal(git(root, 'show', ':app.txt'), 'local staged code');
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/dev'), `${dev}\trefs/heads/dev`);
  assert.deepEqual(git(root, 'diff', '--name-only', dev, pending.commit).split('\n'), [
    reportPath,
    '.issues/issue-numbers.json',
  ]);

  const reviewer = join(directory, 'reviewer');
  git(directory, 'clone', '-b', 'dev', remote, reviewer);
  git(reviewer, 'merge', '--ff-only', `origin/${pending.branch}`);
  git(reviewer, 'push', 'origin', 'dev');
  assert.equal(publication.inspect(issueId).status, 'landed');
  assert.equal(publication.readTarget(issueId).report, report);
  assert.throws(
    () => publication.publish({ issueId, base, report: '# Stale change\n', reason: 'closed' }),
    /shared report changed/
  );
});

test('an interrupted PR request retains and retries the exact checkpoint', (t) => {
  const { root } = fixture(t);
  const attempts = [];
  const publication = createSharedIssuePublication({
    root,
    ...config,
    openPullRequest(record) {
      attempts.push(record.commit);
      if (attempts.length === 1) throw Error('interrupted');
      return { number: 1, url: 'https://example.test/queue/1' };
    },
  });
  const request = { issueId, base: publication.readTarget(issueId), report: '# New report\n', reason: 'created' };
  assert.throws(() => publication.publish(request), /interrupted/);
  assert.equal(publication.listPending()[0].commit, attempts[0]);
  assert.throws(
    () => publication.publish({ ...request, report: '# Different report\n' }),
    /different report checkpoint/
  );
  assert.equal(publication.publish(request).status, 'pending');
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
});

test('human refresh reallocates a stale issue number on the existing PR branch', (t) => {
  const { directory, root, remote } = fixture(t);
  const requestedBranches = [];
  const publication = createSharedIssuePublication({
    root,
    ...config,
    openPullRequest(record) {
      if (!requestedBranches.includes(record.branch)) requestedBranches.push(record.branch);
      const number = requestedBranches.indexOf(record.branch) + 1;
      return { number, url: `https://example.test/queue/${number}` };
    },
  });
  const firstId = '20261111T165430736-1111565563420b';
  const first = publication.publish({
    issueId: firstId,
    base: publication.readTarget(firstId),
    report: '# First\n',
    reason: 'created',
  });
  const request = { issueId, base: publication.readTarget(issueId), report: '# Second\n', reason: 'created' };
  const stale = publication.publish(request);
  assert.equal(first.issueNumber, 1);
  assert.equal(stale.issueNumber, 1);
  const reviewer = join(directory, 'reviewer');
  git(directory, 'clone', '-b', 'dev', remote, reviewer);
  git(reviewer, 'merge', '--ff-only', `origin/${first.branch}`);
  git(reviewer, 'push', 'origin', 'dev');

  const refreshed = publication.reprepare(request);
  assert.equal(refreshed.issueNumber, 2);
  assert.equal(refreshed.branch, stale.branch);
  assert.equal(refreshed.number, stale.number);
  assert.notEqual(refreshed.commit, stale.commit);
  assert.equal(git(root, 'rev-parse', `${refreshed.commit}^`), first.commit);
  assert.equal(git(root, 'show', `${refreshed.commit}:${reportPath}`), '# Second');
  assert.equal(requestedBranches.length, 2);
});

test('an amended checkpoint requires human approval of the merged revision', (t) => {
  const { directory, root, remote } = fixture(t);
  let details;
  const publication = createSharedIssuePublication({
    root,
    ...config,
    openPullRequest: () => ({ number: 1, url: 'https://example.test/queue/1' }),
    inspectPullRequest: () => details,
  });
  const pending = publication.publish({
    issueId,
    base: publication.readTarget(issueId),
    report: '# First draft\n',
    reason: 'created',
  });
  const reviewer = join(directory, 'reviewer');
  git(directory, 'clone', '-b', 'dev', remote, reviewer);
  git(reviewer, 'config', 'user.name', 'Reviewer');
  git(reviewer, 'config', 'user.email', 'reviewer@example.test');
  git(reviewer, 'merge', '--ff-only', `origin/${pending.branch}`);
  writeFileSync(join(reviewer, reportPath), '# Amended report\n');
  git(reviewer, 'add', reportPath);
  git(reviewer, 'commit', '-m', 'Amend report');
  git(reviewer, 'push', 'origin', 'dev');
  const amended = git(reviewer, 'rev-parse', 'HEAD');
  const repo = { full_name: config.repository };
  details = {
    pr: {
      number: 1,
      merged: true,
      merge_commit_sha: amended,
      head: { sha: amended, ref: pending.branch, repo },
      base: { ref: config.target, repo },
    },
    files: [{ filename: reportPath }],
    reviews: [{ user: { id: 3, type: 'User' }, state: 'APPROVED', commit_id: pending.commit }],
  };

  assert.equal(publication.inspect(issueId).status, 'pending');
  assert.throws(() => publication.confirmMerged(issueId), /no human approval/);
  details.reviews[0].commit_id = amended;
  details.files.push({ filename: 'app.txt' });
  assert.throws(() => publication.confirmMerged(issueId), /unexpected files/);
  details.files.pop();
  assert.equal(publication.confirmMerged(issueId).status, 'landed');
  assert.equal(publication.inspect(issueId).mergeCommit, amended);
});
