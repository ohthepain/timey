import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { git } from './factory-ui/common.mjs';
import { createSharedIssueQueue } from './factory-ui/shared-issue-queue.mjs';

const issueId = '20261111T165430736-ca3555165563420b';
const unpublishedId = '20261111T165431736-ca3555165563420b';
const reportPath = `.issues/${issueId}.md`;
const original = '---\nstate: in-progress\n---\n\n# Shared report\n';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'shared-issue-queue-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git');
  const first = join(base, 'first');
  const second = join(base, 'second');
  git(base, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(base, 'clone', '-q', remote, first);
  mkdirSync(join(first, '.issues'));
  writeFileSync(join(first, reportPath), original);
  writeFileSync(join(first, 'factory.config.json'), '{"sharedIssueQueue":true}\n');
  writeFileSync(join(first, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  git(first, 'add', reportPath, 'factory.config.json', '.gitignore');
  git(first, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-qm', 'Seed queue');
  git(first, 'push', '-q', 'origin', 'dev');
  git(base, 'clone', '-q', remote, second);

  const config = { provider: 'github', repository: 'example/timey', remote: 'origin', target: 'dev' };
  for (const root of [first, second]) {
    git(root, 'config', 'user.name', 'Runner');
    git(root, 'config', 'user.email', 'runner@example.test');
    writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  }
  return { remote, first, second };
}

function queue(root, openPullRequest) {
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    store: { runs: [], connected: new Map() },
  };
  return { service, queue: createSharedIssueQueue(service, { openPullRequest }) };
}

test('a stopped runner holds its claim until a human publishes the report', (t) => {
  const { remote, first, second } = fixture(t);
  const reviews = [];
  const { queue: owner, service } = queue(first, (record) => {
    reviews.push(record);
    if (reviews.length === 1) throw Error('Could not create PR.');
    return { number: 1, url: 'https://example.test/queue/1' };
  });
  const { queue: observer } = queue(second, () => assert.fail('Observer did not publish a report.'));
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);

  writeFileSync(join(first, '.issues', `${unpublishedId}.md`), original);
  assert.throws(() => owner.acquire({ id: unpublishedId, content: original }), /unpublished/);
  assert.equal(owner.view(unpublishedId).claimed, false);
  assert.equal(owner.view(unpublishedId).published, false);

  const issue = { id: issueId, content: original };
  const context = owner.acquire(issue);
  assert.equal(observer.refresh(true), null);
  assert.equal(observer.view(issueId).claimed, true);
  assert.throws(() => observer.acquire(issue), /already claims/);

  const work = join(first, '.issues/issue-work');
  mkdirSync(work);
  writeFileSync(join(work, 'run.txt'), 'local workspace\n');
  assert.equal(git(first, 'check-ignore', '.issues/issue-work/run.txt'), '.issues/issue-work/run.txt');
  const updated = original.replace('in-progress', 'in-review');
  writeFileSync(join(first, reportPath), updated);
  const run = { id: 'run-1', status: 'completed' };
  service.lifecycleTasks.set(issueId, {});
  owner.finish(issueId, context, run, { status: 'completed' });
  assert.equal(owner.view(issueId).checkpoint.status, 'failed');
  assert.throws(() => owner.retry(issueId), /current run to stop/);
  service.lifecycleTasks.delete(issueId);
  assert.equal(owner.refresh(true), null);
  assert.equal(reviews.length, 1);
  assert.equal(owner.view(issueId).claimed, true);
  assert.equal(owner.retry(issueId).status, 'review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].commit, reviews[1].commit);
  assert.equal(git(remote, 'show', `dev:${reportPath}`), original.trim());
  assert.equal(git(remote, 'ls-tree', reviews[1].commit, '.issues/issue-work/'), '');

  // Simulate the human merging the queued PR, leaving each factory checkout in place.
  git(remote, 'update-ref', 'refs/heads/dev', reviews[1].commit);
  assert.equal(owner.refresh(true), null);
  assert.equal(owner.view(issueId).checkpoint.status, 'published');
  assert.equal(owner.view(issueId).claimed, false);
  assert.throws(() => observer.acquire(issue), /shared issue changed/);
  assert.equal(observer.refresh(true), null);
  assert.equal(observer.view(issueId).claimed, false);
  const published = readFileSync(join(second, reportPath), 'utf8');
  assert.match(published, /state: in-review/);
  assert.match(published, /shared_progress: completed/);
  assert.match(published, /Run `run-1` ended with status \*\*completed\*\*/);
  assert.equal(readFileSync(join(first, reportPath), 'utf8'), published);
  assert.equal(git(remote, 'ls-tree', 'dev', '.issues/issue-work/'), '');
});
