import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fixture(t, closed = false, separate = true, investigation = false) {
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
  const contents = investigation
    ? `---\nid: ${issueId}\ntitle: Reusable investigation\nrequest_type: investigation\nreusable: true\nstate: backlog\n---\n\n# Investigation\n`
    : closed
      ? `---\nid: ${issueId}\ntitle: Closed report\nstate: closed\n---\n\n# Shared report\n`
      : original;
  if (closed) mkdirSync(join(first, '.issues/closed'));
  writeFileSync(join(first, relative), contents);
  const registry = '.issues/issue-numbers.json';
  if (closed || separate || investigation)
    writeFileSync(join(first, registry), JSON.stringify({ version: 1, next: 2, issues: { [issueId]: 1 } }) + '\n');
  writeFileSync(
    join(first, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, ...(separate && { sharedIssueQueueBranch: 'issue-queue' }) }) + '\n'
  );
  writeFileSync(join(first, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  git(first, 'add', 'factory.config.json', '.gitignore');
  git(first, 'add', '-f', relative, ...(closed || separate || investigation ? [registry] : []));
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
    if (closed) {
      mkdirSync(join(root, '.issues/closed'), { recursive: true });
      writeFileSync(join(root, relative), contents);
    }
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
  return {
    service,
    queue: createSharedIssueQueue(service, {
      openPullRequest,
      pushClaim: (commit, target, _, head) =>
        git(root, 'push', `--force-with-lease=${target}:${head}`, 'origin', `${commit}:${target}`),
    }),
  };
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
  assert.equal(git(remote, 'show', `issue-queue:${reportPath}`), original.trim());
  assert.equal(git(remote, 'ls-tree', reviews[1].commit, '.issues/issue-work/'), '');

  // Simulate the human merging the queued PR, leaving each factory checkout in place.
  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[1].commit);
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
  assert.equal(git(remote, 'ls-tree', 'issue-queue', '.issues/issue-work/'), '');
});

test('an interrupted group closure resumes its claim and publishes to Closed', (t) => {
  const { remote, first } = fixture(t);
  const reason = 'Sub-issue fixed by master issue';
  const { queue: firstRun } = queue(first, () => assert.fail('The first runner was interrupted before publication.'));
  const issue = { id: issueId, content: original };
  assert.equal(firstRun.refresh(true), null);
  const claim = firstRun.acquireGroupClosure(issue, reason).claim;
  const reviews = [];
  const { queue: restarted } = queue(first, (record) => {
    reviews.push(record);
    return { number: 1, url: 'https://example.test/queue/1' };
  });
  assert.equal(restarted.acquireGroupClosure(issue, reason).claim.oid, claim.oid);
  const closed = `---\nid: ${issueId}\ntitle: Shared report\nstate: closed\nclosure:\n  reason: fixed-by\n---\n\n# Shared report\n`;
  writeFileSync(join(first, reportPath), closed);
  assert.equal(restarted.publishGroupClosure({ ...issue, content: closed }, reason).status, 'review');
  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[0].commit);
  assert.equal(restarted.refresh(true), null);
  assert.equal(restarted.view(issueId).checkpoint.status, 'published');
  assert.equal(existsSync(join(first, reportPath)), false);
  assert.match(readFileSync(join(first, `.issues/closed/${issueId}.md`), 'utf8'), /reason: fixed-by/);
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

  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[1].commit);
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);
  assert.equal(owner.storageStatus(issueId).status, 'published');
  assert.equal(owner.view(issueId).claimed, false);
  assert.equal(existsSync(join(first, closedPath)), false);
  assert.equal(existsSync(join(second, closedPath)), false);
  assert.equal(readFileSync(join(first, archivePath), 'utf8'), contents);
  assert.equal(git(remote, 'ls-tree', 'issue-queue', '.issues/archive/'), '');

  assert.equal(owner.moveStorage(issueId, 'restore', contents).status, 'review');
  assert.equal(readFileSync(join(first, archivePath), 'utf8'), contents);
  assert.equal(existsSync(join(first, closedPath)), false);
  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[2].commit);
  assert.equal(owner.refresh(true), null);
  assert.equal(observer.refresh(true), null);
  assert.equal(owner.storageStatus(issueId).status, 'published');
  assert.equal(existsSync(join(first, archivePath)), false);
  assert.equal(readFileSync(join(first, closedPath), 'utf8'), contents);
  assert.equal(readFileSync(join(second, closedPath), 'utf8'), contents);
  assert.equal(JSON.parse(git(remote, 'show', 'issue-queue:.issues/issue-numbers.json')).issues[issueId], 1);
});

test('archiving fetches the shared report once before claiming and rechecks it afterward', (t) => {
  const { first, contents } = fixture(t, true);
  const trace = join(first, 'archive-git.trace');
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    const { queue: owner } = queue(first, () => ({ number: 1, url: 'https://example.test/queue/1' }));
    assert.equal(owner.moveStorage(issueId, 'archive', contents).status, 'review');
    assert.equal(readFileSync(join(first, `.issues/archive/${issueId}.md`), 'utf8'), contents);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
  const fetches = readFileSync(trace, 'utf8')
    .split('\n')
    .filter((line) => /built-in: git fetch /.test(line));
  assert.ok(fetches.some((line) => line.includes('refs/heads/issue-queue')));
  assert.ok(!/built-in: git (?:checkout|switch|merge |rebase )/.test(readFileSync(trace, 'utf8')));
});

test('archive rejects a report changed during claiming and releases the claim', (t) => {
  const { remote, first, relative, contents } = fixture(t, true);
  const changedReport = contents + '\nChanged by another runner.\n';
  const { queue: owner } = queue(first, () => assert.fail('A changed report must not be published.'));
  const hook = join(remote, 'hooks/post-receive');
  // The receive hook appends a report edit while preserving the new claim tree.
  const replacement = join(remote, 'replacement.md');
  writeFileSync(replacement, changedReport);
  writeFileSync(
    hook,
    `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/issue-queue ]; then
    rm -f hooks/post-receive
    export GIT_INDEX_FILE="$PWD/claim-race-index"
    git read-tree "$new"
    blob=$(git hash-object -w replacement.md)
    git update-index --cacheinfo 100644,$blob,${relative}
    tree=$(git write-tree)
    next=$(git -c user.name=Fixture -c user.email=fixture@example.test commit-tree "$tree" -p "$new" -m 'Concurrent report edit')
    git update-ref refs/heads/issue-queue "$next" "$new"
  fi
done
`
  );
  chmodSync(hook, 0o755);
  assert.throws(() => owner.moveStorage(issueId, 'archive', contents), /changed while it was being claimed/);
  assert.equal(owner.view(issueId).claimed, false);
  assert.equal(git(remote, 'ls-tree', 'issue-queue', `.issues/claims/${issueId}.json`), '');
  assert.equal(git(remote, 'show', `issue-queue:${relative}`), changedReport.trim());
  assert.equal(readFileSync(join(first, relative), 'utf8'), contents);
  assert.equal(existsSync(join(first, `.issues/archive/${issueId}.md`)), false);
});

test('Flow can approve a Retro item as soon as its proposal PR lands', async (t) => {
  const { remote, first } = fixture(t, false, true);
  const reviews = [];
  const runner = queue(first, (record) => {
    reviews.push(record);
    return { number: reviews.length, url: `https://example.test/queue/${reviews.length}` };
  });
  runner.service.sharedIssues = runner.queue;
  const flows = createIssueFlows(runner.service, {
    executor: { run: () => assert.fail('Approval started work.'), close() {} },
  });
  runner.service.flows = flows;
  t.after(() => flows.close());
  await flows.fileRetroItems([
    {
      requestId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      title: 'Keep the proof',
      description: 'Save the test result from each run.',
      reason: 'Reviewers can check it later.',
      verification: 'Check the saved result.',
    },
  ]);
  const [proposal] = reviews;
  const { issueId } = proposal;
  const approve = () =>
    flows.action({ action: 'approve-issue', issueId, revision: flows.read(flows.selected(issueId)).revision });
  await assert.rejects(approve(), /Merge the proposal’s queue PR before approving/);
  assert.equal(flows.selected(issueId).state, 'needs-approval');
  assert.equal(runner.queue.view(issueId).claimed, false);
  assert.equal(reviews.length, 1);

  git(remote, 'update-ref', 'refs/heads/issue-queue', proposal.commit);
  assert.equal(runner.queue.view(issueId).checkpoint.status, 'review');
  const approved = await approve();
  assert.equal(approved.issue.state, 'backlog');
  assert.equal(approved.issues.find(({ id }) => id === issueId).folder, 'Retro items');
  assert.equal(approved.sharedQueue.checkpoint.url, 'https://example.test/queue/2');
  assert.equal(approved.sharedQueue.checkpoint.status, 'review');
  assert.match(git(remote, 'show', `issue-queue:.issues/${issueId}.md`), /state: needs-approval/);
  assert.match(git(remote, 'show', `${reviews[1].commit}:.issues/${issueId}.md`), /state: backlog/);
  assert.throws(() => runner.queue.acquire(flows.selected(issueId)), /pending issue update/);
  assert.equal(flows.active.has(issueId), false);
});

test('moving an unpublished proposal retains its failed publication and retries the new folder', async (t) => {
  const { remote, first, second } = fixture(t);
  writeFileSync(
    join(first, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'issue-queue', sharedIssueQueueDirect: true })
  );
  let failPush = true;
  let pushes = 0;
  const runner = queue(first);
  runner.queue.close();
  runner.queue = createSharedIssueQueue(runner.service, {
    pushDirect(commit, target, _, head) {
      pushes++;
      if (failPush) throw Error('Queue push failed.');
      git(first, 'push', `--force-with-lease=${target}:${head}`, 'origin', `${commit}:${target}`);
    },
    pushClaim: (commit, target, _, head) =>
      git(first, 'push', `--force-with-lease=${target}:${head}`, 'origin', `${commit}:${target}`),
  });
  runner.service.sharedIssues = runner.queue;
  const flows = createIssueFlows(runner.service, {
    executor: { run: () => assert.fail('Folder move started work.'), close() {} },
  });
  runner.service.flows = flows;
  t.after(() => {
    flows.close();
    runner.queue.close();
  });
  await flows.fileRetroItems([
    {
      requestId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      title: 'Move the unpublished proposal',
      description: 'Keep folder organization available after a queue push fails.',
      reason: 'Organization is independent of approval.',
      verification: 'Move the issue and retry publication.',
    },
  ]);
  const proposal = (await flows.view()).issues.find((issue) => issue.title === 'Move the unpublished proposal');
  const id = proposal.id;
  assert.equal(runner.queue.view(id).checkpoint.status, 'failed');
  const error = runner.queue.view(id).checkpoint.error;
  await flows.action({ action: 'create-folder', name: 'Review later' });
  const attempts = pushes;
  const moved = await flows.action({
    action: 'folder',
    issueId: id,
    revision: flows.read(flows.selected(id)).revision,
    folder: 'Review later',
  });
  assert.equal(moved.flow.folder, 'Review later');
  assert.equal(moved.issue.state, 'needs-approval');
  assert.equal(pushes, attempts, 'Moving must not retry a failed publication.');
  assert.equal(runner.queue.view(id).checkpoint.status, 'failed');
  assert.equal(runner.queue.view(id).checkpoint.error, error);
  const contents = readFileSync(join(first, `.issues/${id}.md`), 'utf8');
  const pending = JSON.parse(readFileSync(join(first, `.issues/shared-queue/${id}.json`), 'utf8'));
  assert.equal(pending.report, contents);
  failPush = false;
  const retried = runner.queue.retry(id);
  assert.equal(retried.status, 'published', JSON.stringify(retried));
  assert.equal(git(remote, 'show', `issue-queue:.issues/${id}.md`), contents.trim());
  const observer = queue(second);
  t.after(() => observer.queue.close());
  observer.queue.refresh(true);
  assert.equal(readFileSync(join(second, `.issues/${id}.md`), 'utf8'), contents);
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

test('an open investigation archives directly and restores open without inventing closure', (t) => {
  const { remote, first, second, contents } = fixture(t, false, true, true);
  const reviews = [];
  const { queue: owner } = queue(first, (record) => {
    reviews.push(record);
    return { number: reviews.length, url: 'https://example.test/review' };
  });
  const { queue: observer } = queue(second, () => assert.fail('Observer never publishes.'));
  t.after(() => {
    owner.close();
    observer.close();
  });
  owner.refresh(true);
  observer.refresh(true);
  const archivedResult = owner.moveStorage(issueId, 'archive', contents);
  assert.equal(archivedResult.status, 'review', JSON.stringify(archivedResult));
  assert.equal(readFileSync(join(first, reportPath), 'utf8'), contents);
  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[0].commit);
  owner.refresh(true);
  observer.refresh(true);
  assert.equal(existsSync(join(first, reportPath)), false);
  assert.equal(readFileSync(join(first, '.issues/archive', issueId + '.md'), 'utf8'), contents);
  assert.equal(owner.moveStorage(issueId, 'restore', contents).status, 'review');
  git(remote, 'update-ref', 'refs/heads/issue-queue', reviews[1].commit);
  owner.refresh(true);
  observer.refresh(true);
  assert.equal(readFileSync(join(first, reportPath), 'utf8'), contents);
  assert.equal(readFileSync(join(second, reportPath), 'utf8'), contents);
  assert.equal(existsSync(join(first, '.issues/closed', issueId + '.md')), false);
});

test('direct status publication is visible in another clone without updating either source workspace', (t) => {
  const { remote, first, second } = fixture(t);
  for (const root of [first, second]) {
    writeFileSync(
      join(root, 'factory.config.json'),
      JSON.stringify({
        sharedIssueQueue: true,
        sharedIssueQueueBranch: 'issue-queue',
        sharedIssueQueueDirect: true,
      })
    );
    git(root, 'add', 'factory.config.json');
  }
  const make = (root) => {
    const service = {
      root,
      lifecycleRuns: {},
      lifecycleTasks: new Map(),
      issueChats: { tasks: new Map() },
      store: { runs: [], connected: new Map() },
    };
    const push = (commit, target, _, head) =>
      git(root, 'push', `--force-with-lease=${target}:${head}`, 'origin', `${commit}:${target}`);
    const shared = createSharedIssueQueue(service, { pushClaim: push, pushDirect: push });
    t.after(() => shared.close());
    assert.equal(shared.refresh(true), null);
    return shared;
  };
  const owner = make(first);
  const observer = make(second);
  const basis = [first, second].map((root) => {
    writeFileSync(join(root, 'source.txt'), 'Staged code\n');
    git(root, 'add', 'source.txt');
    writeFileSync(join(root, 'source.txt'), 'Unstaged code\n');
    return {
      head: git(root, 'rev-parse', 'HEAD'),
      index: git(root, 'write-tree'),
      status: git(root, 'status', '--porcelain'),
      tracking: git(root, 'rev-parse', 'refs/remotes/origin/dev'),
    };
  });
  const updated = original.replace('in-progress', 'in-review');
  writeFileSync(join(first, reportPath), updated);
  assert.equal(owner.publishDraft(issueId).status, 'published');
  assert.equal(observer.refresh(true), null);
  assert.equal(readFileSync(join(second, reportPath), 'utf8'), updated);
  assert.equal(observer.view(issueId).claimed, false);
  assert.equal(git(remote, 'show', `issue-queue:${reportPath}`), updated.trim());
  const receipt = JSON.parse(readFileSync(join(first, '.issues/shared-publication', issueId + '.json')));
  assert.equal(receipt.atomicRelease.commit, receipt.commit);
  assert.deepEqual(
    git(first, 'diff-tree', '--no-commit-id', '--name-only', '-r', `${receipt.commit}^`, receipt.commit)
      .split('\n')
      .sort(),
    [reportPath, `.issues/claims/${issueId}.json`, '.issues/issue-numbers.json'].sort()
  );
  for (const [i, root] of [first, second].entries()) {
    assert.equal(git(root, 'rev-parse', 'HEAD'), basis[i].head);
    assert.equal(git(root, 'write-tree'), basis[i].index);
    assert.equal(git(root, 'status', '--porcelain'), basis[i].status);
    assert.equal(git(root, 'rev-parse', 'refs/remotes/origin/dev'), basis[i].tracking);
    assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'Unstaged code\n');
  }
  assert.equal(git(remote, 'rev-parse', 'dev'), basis[0].head);
  assert.equal(git(remote, 'for-each-ref', 'refs/heads/claims/'), '');
});
