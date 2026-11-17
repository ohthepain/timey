import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { git } from './factory-ui/common.mjs';
import { createSharedIssueQueue } from './factory-ui/shared-issue-queue.mjs';

const issueId = '20261111T165430736-ca3555165563420b';
const unpublishedId = '20261111T165431736-ca3555165563420b';
const reportPath = `.issues/${issueId}.md`;
const original = '---\ntitle: Shared report\nstate: in-progress\n---\n\n# Shared report\n';

function fixture(t, closed = false, separate = false) {
  const base = mkdtempSync(join(tmpdir(), 'shared-issue-queue-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git');
  const first = join(base, 'first');
  const second = join(base, 'second');
  git(base, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(base, 'clone', '-q', remote, first);
  git(first, 'config', 'user.name', 'Runner');
  git(first, 'config', 'user.email', 'runner@example.test');
  mkdirSync(join(first, '.issues'));
  const relative = closed ? `.issues/closed/${issueId}.md` : reportPath;
  const contents = closed ? `---\nid: ${issueId}\nstate: closed\n---\n\n# Shared report\n` : original;
  if (closed) mkdirSync(join(first, '.issues/closed'));
  writeFileSync(join(first, relative), contents);
  const registry = '.issues/issue-numbers.json';
  if (closed || separate)
    writeFileSync(join(first, registry), JSON.stringify({ version: 1, next: 2, issues: { [issueId]: 1 } }) + '\n');
  writeFileSync(
    join(first, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, ...(separate && { sharedIssueQueueBranch: 'issue-queue' }) }) + '\n'
  );
  writeFileSync(join(first, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  git(first, 'add', relative, 'factory.config.json', '.gitignore', ...(closed || separate ? [registry] : []));
  git(first, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-qm', 'Seed queue');
  if (separate) {
    const prepared = JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-issue-queue.mjs', import.meta.url)), 'HEAD'], {
        cwd: first,
        encoding: 'utf8',
      })
    );
    git(first, 'branch', 'issue-queue', prepared.seed);
    git(first, 'push', '-q', 'origin', 'issue-queue');
    git(first, 'rm', '--', relative, registry);
    git(
      first,
      '-c',
      'user.name=Tester',
      '-c',
      'user.email=tester@example.com',
      'commit',
      '-qm',
      'Move queue out of code'
    );
  }
  git(first, 'push', '-q', 'origin', 'dev');
  git(base, 'clone', '-q', remote, second);

  const config = { provider: 'github', repository: 'example/timey', remote: 'origin', target: 'dev' };
  for (const root of [first, second]) {
    git(root, 'config', 'user.name', 'Runner');
    git(root, 'config', 'user.email', 'runner@example.test');
    mkdirSync(join(root, '.issues'), { recursive: true });
    writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  }
  return { remote, first, second, relative, contents };
}

function queue(root, openPullRequest) {
  const service = {
    root,
    ownServer() {},
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

test('shared archive and restore keep a local copy through failed publication and review', (t) => {
  const { remote, first, second, relative: closedPath, contents } = fixture(t, true);
  const archivePath = `.issues/archive/${issueId}.md`;
  const reviews = [];
  const { queue: owner } = queue(first, (record) => {
    reviews.push(record);
    if (reviews.length === 1) throw Error('Could not create archive PR.');
    return { number: reviews.length, url: `https://example.test/queue/${reviews.length}` };
  });
  const { queue: observer } = queue(second, () => assert.fail('Observer did not publish a report.'));
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);

  assert.equal(owner.moveStorage(issueId, 'archive', contents).status, 'failed');
  assert.equal(readFileSync(join(first, archivePath), 'utf8'), contents);
  assert.equal(readFileSync(join(first, closedPath), 'utf8'), contents);
  assert.equal(git(first, 'check-ignore', archivePath), archivePath);
  assert.equal(owner.storageStatus(issueId).status, 'failed');
  assert.equal(owner.moveStorage(issueId, 'archive', contents).status, 'review');
  assert.equal(reviews[0].commit, reviews[1].commit);
  assert.equal(observer.refresh(true), null);
  assert.equal(readFileSync(join(second, closedPath), 'utf8'), contents);
  assert.equal(existsSync(join(second, archivePath)), false);

  git(remote, 'update-ref', 'refs/heads/dev', reviews[1].commit);
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);
  assert.equal(owner.storageStatus(issueId).status, 'published');
  assert.equal(owner.view(issueId).claimed, false);
  assert.equal(existsSync(join(first, closedPath)), false);
  assert.equal(existsSync(join(second, closedPath)), false);
  assert.equal(readFileSync(join(first, archivePath), 'utf8'), contents);
  assert.equal(git(remote, 'ls-tree', 'dev', '.issues/archive/'), '');

  assert.equal(owner.moveStorage(issueId, 'restore', contents).status, 'review');
  assert.equal(readFileSync(join(first, archivePath), 'utf8'), contents);
  assert.equal(existsSync(join(first, closedPath)), false);
  git(remote, 'update-ref', 'refs/heads/dev', reviews[2].commit);
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);
  assert.equal(owner.storageStatus(issueId).status, 'published');
  assert.equal(existsSync(join(first, archivePath)), false);
  assert.equal(readFileSync(join(first, closedPath), 'utf8'), contents);
  assert.equal(readFileSync(join(second, closedPath), 'utf8'), contents);
  assert.equal(JSON.parse(git(remote, 'show', 'dev:.issues/issue-numbers.json')).issues[issueId], 1);
});

test('two Flow clones share the separate branch without advancing code', async (t) => {
  const { remote, first, second } = fixture(t, false, true);
  const head = git(remote, 'rev-parse', 'dev');
  const reviewed = [];
  const firstRunner = queue(first, (record) => {
    reviewed.push(record);
    return { number: 1, url: 'https://example.test/queue/1' };
  });
  const secondRunner = queue(second, (record) => {
    reviewed.push(record);
    return { number: 2, url: 'https://example.test/queue/2' };
  });
  const running = Promise.withResolvers();
  const entered = Promise.withResolvers();
  function flowFor(runner, run) {
    runner.service.sharedIssues = runner.queue;
    const flows = createIssueFlows(runner.service, {
      executor: { run, close() {} },
    });
    runner.service.flows = flows;
    t.after(() => flows.close());
    return flows;
  }
  const left = flowFor(firstRunner, async () => {
    assert.equal(firstRunner.queue.view(issueId).local, true);
    entered.resolve();
    await running.promise;
    return { summary: 'Work completed' };
  });
  const right = flowFor(secondRunner, async () => assert.fail('Competing runner acquired the issue'));
  assert.equal((await left.view(issueId)).issue.issueNumber, 1);
  assert.equal((await right.view(issueId)).issue.issueNumber, 1);
  const work = (flows) => {
    const issue = flows.selected(issueId);
    const flow = flows.read(issue);
    const block = flow.blocks.find(({ kind }) => kind === 'work');
    return flows.start(issue, flow, { blockId: block.id }, flows.catalog.read().entries);
  };
  await work(left);
  await entered.promise;
  try {
    await work(right);
    const attempt = right
      .read(right.selected(issueId))
      .blocks.find(({ kind }) => kind === 'work')
      .attempts.at(-1);
    assert.equal(attempt.status, 'blocked');
    assert.match(attempt.summary, /already claims/);
  } finally {
    const task = left.active.get(issueId).task;
    running.resolve();
    await task;
  }
  assert.equal(firstRunner.queue.view(issueId).local, false);
  assert.equal(git(remote, 'for-each-ref', 'refs/heads/claims'), '');

  const create = (flows, requestId, description) => flows.capture({ requestId, description, type: 'feature' });
  const [a, b] = await Promise.all([
    create(left, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Add the first setting'),
    create(right, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Add the second setting'),
  ]);
  assert.equal(a.sharedQueue.checkpoint.status, 'review');
  assert.equal(b.sharedQueue.checkpoint.status, 'review');
  const leftPR = reviewed.find(({ issueId }) => issueId === a.issue.id);
  const rightPR = reviewed.find(({ issueId }) => issueId === b.issue.id);
  assert.equal(leftPR.target, 'issue-queue');
  assert.equal(rightPR.target, 'issue-queue');
  assert.equal(leftPR.issueNumber, rightPR.issueNumber);
  git(remote, 'update-ref', 'refs/heads/issue-queue', leftPR.commit);
  assert.equal(secondRunner.queue.retry(b.issue.id).status, 'review');
  const retried = reviewed.at(-1);
  assert.equal(retried.branch, rightPR.branch);
  assert.notEqual(retried.issueNumber, leftPR.issueNumber);
  git(remote, 'update-ref', 'refs/heads/issue-queue', retried.commit);
  assert.equal(firstRunner.queue.refresh(true), null);
  assert.equal(secondRunner.queue.refresh(true), null);
  for (const flows of [left, right]) {
    assert.equal((await flows.view(a.issue.id)).issue.issueNumber, leftPR.issueNumber);
    assert.equal((await flows.view(b.issue.id)).issue.issueNumber, retried.issueNumber);
  }
  assert.equal(git(remote, 'rev-parse', 'dev'), head);
  assert.equal(git(first, 'rev-parse', 'HEAD'), head);
  assert.equal(git(second, 'rev-parse', 'HEAD'), head);
  assert.equal(git(remote, 'ls-tree', 'dev', reportPath), '');
});
