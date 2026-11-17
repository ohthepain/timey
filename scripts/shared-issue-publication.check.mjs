import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSharedIssuePublication } from './factory-ui/shared-issue-publication.mjs';
import { syncSharedIssueFiles } from './factory-ui/shared-issue-sync.mjs';

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

test('direct queue publication survives a competing number allocation and a lost push response', (t) => {
  const { root, remote, directory } = fixture(t);
  const target = 'issue-queue';
  const ref = `refs/heads/${target}`;
  const otherId = '20261111T165430737-ca3555165563420c';
  git(root, 'push', 'origin', `HEAD:${ref}`);
  const other = join(directory, 'other');
  git(directory, 'clone', '-b', 'dev', remote, other);
  git(other, 'config', 'user.name', 'Other runner');
  git(other, 'config', 'user.email', 'other@example.test');
  const direct = { ...config, target, separateBranch: target, direct: true };
  const competitor = createSharedIssuePublication({
    root: other,
    ...direct,
    pushDirect: (commit, destination) => git(other, 'push', 'origin', `${commit}:${destination}`),
  });
  const dev = git(root, 'rev-parse', 'HEAD');
  let pushes = 0;
  const publication = createSharedIssuePublication({
    root,
    ...direct,
    openPullRequest: () => assert.fail('Direct publication opened a pull request.'),
    pushDirect(commit, destination) {
      assert.equal(destination, ref);
      if (++pushes === 1) competitor.publish({ issueId: otherId, base: null, report: 'Other report\n' });
      git(root, 'push', 'origin', `${commit}:${destination}`);
      throw Error('The response was lost after Git received the push.');
    },
  });
  const request = { issueId, base: null, report: 'First report\n' };
  const landed = publication.publish(request);
  assert.equal(landed.status, 'landed');
  assert.equal(landed.mergeCommit, landed.commit);
  assert.equal(publication.publish(request).commit, landed.commit);
  assert.equal(pushes, 2);
  const queue = publication.readTarget(issueId);
  assert.equal(queue.report, request.report);
  const numbers = JSON.parse(queue.numbers).issues;
  assert.equal(new Set([numbers[issueId], numbers[otherId]]).size, 2);
  assert.equal(publication.readTarget(otherId).report, 'Other report\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), dev);
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/dev'), `${dev}\trefs/heads/dev`);
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/queue-updates/*'), '');
});

test('direct publishing refuses to replace a report changed by another runner', (t) => {
  const { root } = fixture(t);
  const target = 'issue-queue';
  const ref = `refs/heads/${target}`;
  git(root, 'push', 'origin', `HEAD:${ref}`);
  const publication = createSharedIssuePublication({
    root,
    ...config,
    target,
    separateBranch: target,
    direct: true,
    pushDirect: (commit, destination) => git(root, 'push', 'origin', `${commit}:${destination}`),
  });
  publication.publish({ issueId, base: null, report: 'Another runner wrote this.\n' });
  assert.throws(
    () => publication.publish({ issueId, base: null, report: 'I prepared a stale update.\n' }),
    /shared report changed/
  );
  assert.equal(publication.readTarget(issueId).report, 'Another runner wrote this.\n');
});

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

test('a queue without required reviews accepts only the exact checkpoint after merge', (t) => {
  const { root, remote } = fixture(t);
  let details;
  const publication = createSharedIssuePublication({
    root,
    ...config,
    requireReview: false,
    openPullRequest: () => ({ number: 1 }),
    inspectPullRequest: () => details,
  });
  const pending = publication.publish({ issueId, base: null, report: '# Queue report\n', reason: 'created' });
  git(remote, 'update-ref', 'refs/heads/dev', pending.commit);
  const repo = { full_name: config.repository };
  details = {
    pr: {
      number: pending.number,
      merged: true,
      merge_commit_sha: pending.commit,
      head: { sha: pending.commit, ref: pending.branch, repo },
      base: { ref: config.target, repo },
    },
    files: [{ filename: reportPath }, { filename: '.issues/issue-numbers.json' }],
    reviews: [],
  };
  const exactHead = details.pr.head.sha;
  details.pr.head.sha = git(root, 'rev-parse', 'HEAD');
  assert.throws(() => publication.confirmMerged(issueId), /head changed/);
  details.pr.head.sha = exactHead;
  details.files.push({ filename: 'app.txt' });
  assert.throws(() => publication.confirmMerged(issueId), /unexpected files/);
  details.files.pop();
  const reviewer = join(root, '..', 'reviewer');
  git(root, 'clone', '-b', 'dev', remote, reviewer);
  writeFileSync(join(reviewer, reportPath), '# Changed merge content\n');
  git(reviewer, 'add', reportPath);
  git(reviewer, '-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.test', 'commit', '-m', 'Change report');
  git(reviewer, 'push', 'origin', 'dev');
  details.pr.merge_commit_sha = git(reviewer, 'rev-parse', 'HEAD');
  assert.throws(() => publication.confirmMerged(issueId), /differs from the saved queue checkpoint/);
  git(remote, 'update-ref', 'refs/heads/dev', pending.commit);
  details.pr.merge_commit_sha = pending.commit;
  assert.equal(publication.confirmMerged(issueId).status, 'landed');
});

test('reviewed moves and archive removals preserve the canonical report and reserved number', (t) => {
  const { root, remote } = fixture(t);
  const closedPath = `.issues/closed/${issueId}.md`;
  let details;
  const publication = createSharedIssuePublication({
    root,
    ...config,
    openPullRequest: () => ({ number: 1, url: 'https://example.test/queue/1' }),
    inspectPullRequest: () => details,
  });
  const report = '# Report\n';
  const create = publication.publish({ issueId, base: null, report, reason: 'created' });
  git(remote, 'update-ref', 'refs/heads/dev', create.commit);
  const open = publication.readTarget(issueId);
  assert.equal(open.location, 'open');
  assert.throws(
    () => publication.publish({ issueId, base: open, report: null, location: null, reason: 'archive' }),
    /Only a shared closed report/
  );

  const close = publication.publish({ issueId, base: open, report, location: 'closed', reason: 'closed' });
  assert.deepEqual(git(root, 'diff', '--no-renames', '--name-only', create.commit, close.commit).split('\n'), [
    reportPath,
    closedPath,
  ]);
  assert.equal(publication.inspect(issueId).status, 'pending');
  git(remote, 'update-ref', 'refs/heads/dev', close.commit);
  assert.equal(publication.readTarget(issueId).location, 'closed');

  const repo = { full_name: config.repository };
  const approvals = (record, files) => ({
    pr: {
      number: record.number,
      merged: true,
      merge_commit_sha: record.commit,
      head: { sha: record.commit, ref: record.branch, repo },
      base: { ref: config.target, repo },
    },
    files,
    reviews: [{ user: { id: 3, type: 'User' }, state: 'APPROVED', commit_id: record.commit }],
  });
  details = approvals(close, [{ filename: closedPath, previous_filename: reportPath, status: 'renamed' }]);
  assert.equal(publication.confirmMerged(issueId).status, 'landed');

  const base = publication.readTarget(issueId);
  const archive = publication.publish({ issueId, base, report: null, location: null, reason: 'archive' });
  assert.equal(git(root, 'diff', '--name-only', close.commit, archive.commit), closedPath);
  assert.equal(publication.readTarget(issueId).report, report);
  assert.equal(publication.inspect(issueId).status, 'pending');
  git(remote, 'update-ref', 'refs/heads/dev', archive.commit);
  details = approvals(archive, [{ filename: closedPath, status: 'removed' }]);
  assert.equal(publication.confirmMerged(issueId).status, 'landed');
  const absent = publication.readTarget(issueId);
  assert.equal(absent.location, null);
  assert.equal(absent.numbers, base.numbers);

  const restore = publication.publish({ issueId, base: absent, report, location: 'closed', reason: 'restored' });
  assert.equal(restore.issueNumber, create.issueNumber);
  assert.equal(git(root, 'diff', '--name-only', archive.commit, restore.commit), closedPath);
});

test('sync mirrors a reviewed move only when both local paths are safe', (t) => {
  const { root, remote } = fixture(t);
  const publication = createSharedIssuePublication({ root, ...config, openPullRequest: () => ({ number: 1 }) });
  const report = '# Report\n';
  const closedPath = `.issues/closed/${issueId}.md`;
  const archiveDir = join(root, '.issues/archive');
  mkdirSync(archiveDir, { recursive: true });
  const archiveCopy = join(archiveDir, issueId + '.md');
  writeFileSync(archiveCopy, '# Local archive\n');
  const state = join(root, '.issues', 'sync.json');
  const create = publication.publish({ issueId, base: null, report, reason: 'created' });
  git(remote, 'update-ref', 'refs/heads/dev', create.commit);
  assert.deepEqual(
    syncSharedIssueFiles(root, config, state, () => false),
    []
  );
  const close = publication.publish({
    issueId,
    base: publication.readTarget(issueId),
    report,
    location: 'closed',
    reason: 'closed',
  });
  git(remote, 'update-ref', 'refs/heads/dev', close.commit);
  writeFileSync(join(root, reportPath), '# Local edit\n');
  assert.equal(syncSharedIssueFiles(root, config, state, () => false).length, 1);
  assert.equal(existsSync(join(root, closedPath)), false);
  assert.equal(readFileSync(join(root, reportPath), 'utf8'), '# Local edit\n');
  writeFileSync(join(root, reportPath), report);
  assert.deepEqual(
    syncSharedIssueFiles(root, config, state, (id) => id === issueId),
    []
  );
  assert.equal(existsSync(join(root, closedPath)), false);
  assert.deepEqual(
    syncSharedIssueFiles(root, config, state, () => false),
    []
  );
  assert.equal(existsSync(join(root, reportPath)), false);
  assert.equal(readFileSync(join(root, closedPath), 'utf8'), report);

  const archive = publication.publish({
    issueId,
    base: publication.readTarget(issueId),
    report: null,
    location: null,
    reason: 'archive',
  });
  git(remote, 'update-ref', 'refs/heads/dev', archive.commit);
  assert.deepEqual(
    syncSharedIssueFiles(root, config, state, () => false),
    []
  );
  assert.equal(existsSync(join(root, closedPath)), false);
  assert.equal(readFileSync(archiveCopy, 'utf8'), '# Local archive\n');
});
