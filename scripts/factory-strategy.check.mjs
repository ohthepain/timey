import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { git, writeJson } from './factory-ui/common.mjs';
import {
  mergeIssueStrategyPR,
  strategyView,
  startIssueStrategy,
  verifyExternalIssueDelivery,
} from './factory-ui/issue-strategy.mjs';
import { GitHubAppCredentials, githubAppCredentials } from './factory-ui/github-app.mjs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { strategyPrompt } from './factory-ui/strategy-prompt.mjs';
import { runSolLoop } from './factory-ui/strategy-review.mjs';
import { saveConversationState } from './factory-ui/conversation-store.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { infrastructureFailure, repairableBlocker, retryInfrastructure } from './factory-ui/strategy-repair.mjs';
import { synchronizeStrategyTarget } from './factory-ui/strategy-target.mjs';
import { gitFixture } from './git-fixture.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { publishStrategyPR } from './factory-ui/strategy-publication.mjs';
import { humanGuard } from './factory-ui/guard.mjs';

function fixture(t) {
  const { queue, source } = deliveryFixture(t);
  queue.git('branch', '-M', 'main');
  writeJson(join(queue.root, '.issues/issue-delivery-config.json'), {
    provider: 'github',
    repository: 'fixture/timey',
    remote: 'origin',
    target: 'main',
  });
  const remote = join(queue.root, '.issues/target.git');
  queue.git('init', '--bare', '-q', remote);
  queue.git('remote', 'add', 'origin', remote);
  queue.git('push', 'origin', `${queue.git('rev-parse', 'HEAD')}:refs/heads/main`);
  const service = new FactoryUI(queue.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.guard = () => [];
  service.strategySyncTarget = async (work) => {
    work.targetRevision = work.base;
    return false;
  };
  service.strategyDelay = async () => {};
  let calls = 0,
    merges = 0,
    checks = 0;
  service.issueTitleUpdates = [];
  service.codex.start = async (_cwd, _sandbox, retain) => {
    retain?.({ status: 'ready', threadId: 'owning-chat' });
    return 'owning-chat';
  };
  service.codex.resume = async () => {};
  service.codex.ready = async () => {};
  service.codex.call = async (method) => (method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : {});
  const codexCall = service.codex.call;
  service.codex.call = async (method, params) => {
    if (method === 'thread/name/set') service.issueTitleUpdates.push(params.name);
    return codexCall(method, params);
  };
  service.codex.turn = async (_thread, cwd, prompt) => {
    calls++;
    assert.match(prompt, /No lifecycle roles or stage transitions/);
    assert.match(prompt, /Never push the target branch/);
    assert.equal(cwd, service.lifecycleRuns['20261025-one'].work.checkout);
    const repairing = prompt.includes('Required repair attempt:');
    if (repairing) {
      writeFileSync(join(cwd, 'repair.js'), `export const attempt = ${calls};\n`);
      git(cwd, 'add', 'repair.js');
      git(cwd, 'commit', '-qm', 'repair blocker');
    } else if (!existsSync(join(cwd, 'change.js'))) {
      writeFileSync(join(cwd, 'change.js'), 'export const changed = true;\n');
      git(cwd, 'add', 'change.js');
      git(cwd, 'commit', '-qm', 'issue implementation');
    }
    return JSON.stringify({
      outcome: 'completed',
      summary: 'Ready for handoff',
      pr: service.lifecycleRuns['20261025-one'].work.pr || null,
      publication: { title: 'Issue fix', body: 'Implemented and checked the issue.' },
      remaining: [],
      repair: repairing ? { approach: `Repair approach ${calls}`, evidence: [] } : null,
      blocker: null,
    });
  };
  service.check = async (cwd) => {
    checks++;
    return {
      head: git(cwd, 'rev-parse', 'HEAD'),
      tree: git(cwd, 'rev-parse', 'HEAD^{tree}'),
      summaries: [],
      passed: true,
    };
  };
  service.strategyProvider = () => ({
    assertMergeProtection: async () => true,
    publish: async () => ({ number: 12 }),
    inspect: () => ({}),
    findByBranch: async () => {
      const work = service.lifecycleRuns['20261025-one']?.work;
      if (!work?.pr || !work.prHead) return null;
      return {
        number: work.pr,
        state: work.merge ? 'closed' : 'open',
        merged_at: work.merge ? '2026-11-04T17:00:00Z' : null,
        merge_commit_sha: work.merge?.revision,
        head: { ref: work.branch, sha: work.prHead, repo: { full_name: 'fixture/timey' } },
        base: { ref: 'main', repo: { full_name: 'fixture/timey' } },
        html_url: 'https://github.com/fixture/timey/pull/' + work.pr,
      };
    },
    ready: (_pr, _branch, head) => ({
      head,
      number: 12,
      url: 'https://github.com/fixture/timey/pull/12',
      target: queue.git('rev-parse', 'HEAD'),
    }),
    assertApproved: async () => true,
    merge: () => {
      merges++;
      return { url: 'https://github.com/fixture/timey/pull/12', revision: 'merge' };
    },
  });
  const issue = readQueue(queue.root).issues[0];
  const input = (strategy = 'full-stop') => ({
    issueId: issue.id,
    basis: strategyView(service, issue).basis,
    strategy,
    solRounds: 0,
    approved: true,
  });
  return { queue, source, service, issue, input, counts: () => ({ calls, merges, checks }) };
}

async function mergeReadyIssue(f) {
  const work = f.service.lifecycleRuns[f.issue.id].work;
  return mergeIssueStrategyPR(f.service, {
    issueId: f.issue.id,
    runId: work.runId,
    pr: work.pr,
    head: work.prHead,
  });
}

test('Full Stop uses one chat/branch, checks once and hands off without merge or stage transitions', async (t) => {
  const f = fixture(t);
  const state = f.issue.state;
  const started = startIssueStrategy(f.service, f.input());
  assert.equal(started.accepted, true);
  assert.throws(() => startIssueStrategy(f.service, f.input()), /already working/);
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.equal(record.workThreadId, 'owning-chat');
  assert.equal(record.work.branch, 'codex/issue-' + f.issue.id);
  assert.equal(readQueue(f.queue.root).issues[0].state, state);
  assert.deepEqual(f.counts(), { calls: 1, merges: 0, checks: 1 });
  assert.equal(readQueue(f.queue.root).actions.length, 0);
  const receipt = JSON.parse(readFileSync(record.work.receipt));
  assert.equal(receipt.actor, 'human');
  assert.equal(receipt.strategy, 'full-stop');
  const checkout = record.work.checkout;
  assert.throws(() => startIssueStrategy(f.service, f.input('full-send')), /saved issue strategy/);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.checkout, checkout);
  assert.equal(f.service.lifecycleRuns[f.issue.id].workThreadId, 'owning-chat');
  assert.deepEqual(f.counts(), { calls: 1, merges: 0, checks: 1 }, 'Continue reuses the unchanged checked PR');
});

test('Continue recognizes a manually merged, unchanged checked PR after pending checks without replaying work', async (t) => {
  const f = fixture(t);
  f.service.strategyReadinessTimeout = -1;
  const checkCandidate = f.service.check;
  f.service.check = async (cwd, base, folder) => {
    const checked = await checkCandidate(cwd, base, folder);
    const summaries = ['verification', 'step'].map((checkpoint) => {
      const summary = JSON.parse(readFileSync(join(f.source.root, '.issues', checkpoint + '.json')));
      summary.base = base;
      summary.snapshot_tree = checked.tree;
      const path = join(folder, 'fixture-' + checkpoint + '.json');
      writeJson(path, summary);
      return path;
    });
    return { ...checked, summaries };
  };
  const provider = f.service.strategyProvider();
  provider.ready = async () => {
    throw Object.assign(Error('PR checks are pending.'), { code: 'STRATEGY_PENDING' });
  };
  f.service.strategyProvider = () => provider;
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  const checkout = record.work.checkout;
  const prHead = record.work.verification.head;
  const checked = record.work.verification.checked;
  record.work.pr = null;
  assert.equal(record.status, 'blocked');
  assert.equal(record.work.prHead, prHead);
  assert.equal(f.service.store.runs.at(-1).result.checked.head, prHead);

  git(checkout, 'commit', '--allow-empty', '-qm', 'manual merge with matching tree');
  const mergeRevision = git(checkout, 'rev-parse', 'HEAD');
  provider.inspect = () => ({
    number: 12,
    state: 'closed',
    merged_at: '2026-11-04T17:00:00Z',
    merge_commit_sha: mergeRevision,
    html_url: 'https://github.com/fixture/timey/pull/12',
  });
  provider.findByBranch = async (branch) => ({
    number: 12,
    state: 'closed',
    merged_at: '2026-11-04T17:00:00Z',
    merge_commit_sha: mergeRevision,
    head: { ref: branch, sha: prHead, repo: { full_name: 'fixture/timey' } },
    base: { ref: 'main', repo: { full_name: 'fixture/timey' } },
    html_url: 'https://github.com/fixture/timey/pull/12',
  });
  const readinessHeads = [];
  provider.ready = async (_pr, branch, head) => {
    assert.equal(branch, record.work.branch);
    readinessHeads.push(head);
    return {
      number: 12,
      url: 'https://github.com/fixture/timey/pull/12',
      head,
      target: 'target-after-merge',
      checks: [{ name: 'verify', status: 'success' }],
      merged: true,
      merge: { url: 'https://github.com/fixture/timey/pull/12', revision: mergeRevision },
    };
  };
  f.service.strategyProvider = () => provider;

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  assert.equal(record.status, 'merged', record.summary);
  assert.match(f.service.issueTitleUpdates.at(-1), / · waiting$/);
  assert.doesNotMatch(f.service.issueTitleUpdates.at(-1), / · archiveable$/);
  assert.equal(readQueue(f.queue.root).issues[0].accepted_result, undefined, 'merge does not accept the issue');
  assert.equal(record.work.pr, 12, 'the matching PR is recovered from the issue branch');
  assert.equal(record.work.prHead, prHead);
  assert.equal(record.work.verification.head, prHead);
  assert.equal(record.work.verification.checked, checked);
  assert.deepEqual(f.counts(), { calls: 1, merges: 0, checks: 1 });
  assert.equal(record.work.merge.revision, mergeRevision);
  assert.deepEqual(readinessHeads, [prHead], 'readiness stays bound to the verified PR head');
  assert.equal(f.service.store.runs.at(-1).result.checked, checked);
  const queue = readQueue(f.queue.root);
  const closed = f.service.decideIssue(f.issue.id, f.issue.state, 'close', decisionBasis(queue, queue.issues[0]));
  assert.equal(closed.state, 'closed');
  assert.equal(readQueue(f.queue.root).issues[0].accepted_result.revision, prHead);
  assert.deepEqual(
    f.counts(),
    { calls: 1, merges: 0, checks: 1 },
    'Fixed closure uses the retained result without work'
  );
});

test('Continue does not accept a manual merge that changed the checked candidate tree', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  const prHead = record.work.verification.head;
  const checkout = record.work.checkout;
  record.work.pr = 99;

  writeFileSync(join(checkout, 'change.js'), 'export const changed = false;\n');
  git(checkout, 'add', 'change.js');
  git(checkout, 'commit', '-qm', 'manual merge resolution changed verified content');
  const mergeRevision = git(checkout, 'rev-parse', 'HEAD');
  const provider = f.service.strategyProvider();
  provider.inspect = () => ({
    number: 12,
    state: 'closed',
    merged_at: '2026-11-04T17:00:00Z',
    merge_commit_sha: mergeRevision,
    html_url: 'https://github.com/fixture/timey/pull/12',
  });
  provider.findByBranch = async (branch) => ({
    number: 12,
    state: 'closed',
    merged_at: '2026-11-04T17:00:00Z',
    merge_commit_sha: mergeRevision,
    head: { ref: branch, sha: prHead, repo: { full_name: 'fixture/timey' } },
    base: { ref: 'main', repo: { full_name: 'fixture/timey' } },
    html_url: 'https://github.com/fixture/timey/pull/12',
  });
  provider.ready = async (_pr, _branch, head) => {
    if (head !== prHead) throw Error('The PR branch, target or candidate changed.');
    return { head, merged: true, merge: { revision: mergeRevision } };
  };
  f.service.strategyProvider = () => provider;

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  assert.notEqual(record.status, 'merged');
  assert.deepEqual(
    record.work.prDiscrepancy && [record.work.prDiscrepancy.saved, record.work.prDiscrepancy.discovered],
    [99, 12]
  );
  assert.equal(record.work.merge, undefined);
  assert.equal(f.counts().merges, 0);
  assert.ok(f.counts().calls > 1, 'changed content stays on the repair path');
});

test('new strategy publication is server-owned, follows verification and retains the PR before readiness', async (t) => {
  const f = fixture(t);
  const provider = f.service.strategyProvider();
  let publications = 0;
  provider.publish = async (work, head, publication) => {
    publications++;
    assert.equal(f.counts().checks, 1);
    assert.equal(work.verification.head, head);
    assert.equal(publication.title, 'Issue fix');
    return { number: 12 };
  };
  provider.inspect = () => {
    assert.equal(f.service.lifecycleRuns[f.issue.id].work.pr, 12);
    return {};
  };
  f.service.strategyProvider = () => provider;
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'handed-off');
  assert.equal(publications, 1);
});

function publicationFixture() {
  const work = { branch: 'codex/issue-one' };
  const pr = {
    number: 12,
    state: 'open',
    draft: false,
    user: { login: 'factory[bot]' },
    head: { ref: work.branch, sha: 'head', repo: { full_name: 'fixture/timey' } },
    base: { ref: 'main', repo: { full_name: 'fixture/timey' } },
  };
  const calls = [];
  const provider = {
    config: { repository: 'fixture/timey', target: 'main' },
    credentials: { session: async () => ({ slug: 'factory' }) },
    gh: async (args) => {
      calls.push(args);
      if (args[1].includes('/pulls?')) return '[]';
      if (args[1].includes('/git/ref/')) return JSON.stringify({ object: { sha: 'head' } });
      return JSON.stringify(pr);
    },
  };
  return { work, pr, calls, provider, publication: { title: 'Fix issue', body: 'Changes and evidence.' } };
}

test('App publication validates author and exact pushed candidate without personal fallback', async () => {
  const f = publicationFixture();
  assert.equal((await publishStrategyPR(f.provider, f.work, 'head', f.publication)).number, 12);
  assert.ok(f.calls.at(-1).includes('draft=false'));
  f.provider.credentials = null;
  f.calls.length = 0;
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'head', f.publication), /requires configured GitHub App/);
  assert.equal(f.calls.length, 0);
});

test('external delivery requires a merged PR to the configured target, current target ancestry and passing checks', async () => {
  const provider = new StrategyProvider('/tmp', { repository: 'fixture/timey', target: 'dev' });
  const pr = {
    number: 19,
    state: 'closed',
    merged_at: '2026-11-04T18:00:00Z',
    merge_commit_sha: 'merge-sha',
    html_url: 'https://github.com/fixture/timey/pull/19',
    head: { sha: 'head-sha', repo: { full_name: 'contributor/timey' } },
    base: { ref: 'dev', repo: { full_name: 'fixture/timey' } },
  };
  const calls = [];
  provider.gh = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/pulls/19')) return JSON.stringify(pr);
    if (args[0] === 'api' && args[1].includes('/compare/'))
      return JSON.stringify({ status: 'ahead', behind_by: 0, head_sha: 'target-sha' });
    return JSON.stringify({
      files: [{ path: 'src/feature.ts' }],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
  };
  const result = await provider.inspectExternalDelivery(19);
  assert.equal(result.targetRevision, 'target-sha');
  assert.equal(result.mergeCommit, 'merge-sha');
  assert.deepEqual(result.files, ['src/feature.ts']);
  assert.equal(calls.length, 3);

  provider.gh = async (args) => {
    if (args[1].includes('/pulls/19')) return JSON.stringify({ ...pr, base: { ...pr.base, ref: 'main' } });
    throw Error('unexpected call');
  };
  await assert.rejects(provider.inspectExternalDelivery(19), /merged into fixture\/timey:dev/);

  provider.gh = async (args) => {
    if (args[1].includes('/pulls/19')) return JSON.stringify(pr);
    if (args[1].includes('/compare/')) return JSON.stringify({ status: 'behind', behind_by: 1 });
    throw Error('unexpected call');
  };
  await assert.rejects(provider.inspectExternalDelivery(19), /no longer contains/);
});

test('external delivery is recorded distinctly and never accepts the issue', async (t) => {
  const f = fixture(t);
  const issueState = f.issue.state;
  f.service.lifecycleRuns[f.issue.id] = {
    id: 'external',
    issueId: f.issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  const provider = StrategyProvider.prototype.inspectExternalDelivery;
  StrategyProvider.prototype.inspectExternalDelivery = async () => ({
    number: 19,
    url: 'https://github.com/fixture/timey/pull/19',
    target: 'main',
    targetRevision: 'target-sha',
    head: 'head-sha',
    mergedAt: '2026-11-04T18:00:00Z',
    mergeCommit: 'merge-sha',
    checks: [{ name: 'test', conclusion: 'SUCCESS' }],
    files: ['src/feature.ts'],
  });
  t.after(() => (StrategyProvider.prototype.inspectExternalDelivery = provider));
  const result = await verifyExternalIssueDelivery(f.service, {
    issueId: f.issue.id,
    number: 19,
    behaviorEvidence: 'Implements the requested behavior in src/feature.ts and retains the expected current behavior.',
  });
  assert.equal(result.delivery.status, 'verified-awaiting-acceptance');
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'verified-awaiting-acceptance');
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.pr, undefined);
  assert.equal(f.issue.state, issueState);
});

test('partial external delivery records outstanding requirements and continuation avoids repeating covered behavior', async (t) => {
  const f = fixture(t);
  const provider = StrategyProvider.prototype.inspectExternalDelivery;
  let targetRevision = 'target-before';
  StrategyProvider.prototype.inspectExternalDelivery = async () => ({
    number: 19,
    url: 'https://github.com/fixture/timey/pull/19',
    target: 'main',
    targetRevision,
    head: 'head-sha',
    mergedAt: '2026-11-04T18:00:00Z',
    mergeCommit: 'merge-sha',
    checks: [{ name: 'test', conclusion: 'SUCCESS' }],
    files: ['src/feature.ts'],
  });
  t.after(() => (StrategyProvider.prototype.inspectExternalDelivery = provider));
  await verifyExternalIssueDelivery(f.service, {
    issueId: f.issue.id,
    number: 19,
    behaviorEvidence: 'Implements the first requested behavior in src/feature.ts and passes its checks.',
  });
  targetRevision = 'target-after-change';
  const result = await verifyExternalIssueDelivery(f.service, {
    issueId: f.issue.id,
    number: 19,
    behaviorEvidence: 'The current target was rechecked; src/feature.ts still implements the first behavior.',
    remainingCriteria: 'The second requested behavior is absent from the current target.',
  });
  assert.equal(result.delivery.status, 'partial-awaiting-acceptance');
  assert.equal(result.delivery.targetChangedSincePreviousCheck, true);
  assert.equal(result.delivery.previousTargetRevision, 'target-before');
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'partial-delivery');

  const originalTurn = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    assert.match(args[2], /remainingCriteria.*second requested behavior/);
    assert.match(args[2], /do not repeat behavior already covered/);
    return originalTurn(...args);
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.externalDelivery.status, 'partial-awaiting-acceptance');
});

test('an uncertain App create is discovered on retry; personal and closed PRs are preserved', async () => {
  const f = publicationFixture();
  let created = false;
  const original = f.provider.gh;
  f.provider.gh = async (args) => {
    if (created && args[1].includes('/pulls?')) return JSON.stringify([f.pr]);
    const result = await original(args);
    if (args.includes('POST')) {
      created = true;
      throw Object.assign(Error('connection reset'), { transient: true });
    }
    return result;
  };
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'head', f.publication), /connection reset/);
  await publishStrategyPR(f.provider, f.work, 'head', f.publication);
  assert.equal(f.calls.filter((args) => args.includes('POST')).length, 1);
  f.pr.user.login = 'owner';
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'head', f.publication), /personal account/);
  f.pr.user.login = 'factory[bot]';
  f.pr.state = 'closed';
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'head', f.publication), /open, non-draft/);
  assert.equal(f.calls.filter((args) => args.includes('POST')).length, 1);
});

test('App publication refuses an unpushed candidate and wrong PR identity', async () => {
  const f = publicationFixture();
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'other', f.publication), /Push the verified/);
  assert.equal(
    f.calls.some((args) => args.includes('POST')),
    false
  );
  f.pr.head.sha = 'other';
  await assert.rejects(publishStrategyPR(f.provider, f.work, 'head', f.publication), /candidate changed/);
});

test('a worker cannot introduce a personally published PR into new strategy work', async (t) => {
  const f = fixture(t);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    const result = JSON.parse(await owner(...args));
    return JSON.stringify({ ...result, pr: 99 });
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /server owns PR publication/);
  assert.equal(record.work.pr, null);
  assert.equal(f.counts().checks, 0);
  assert.equal(f.counts().merges, 0);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.pr, null, 'Continue cannot adopt the rejected worker PR');
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'blocked');
});

test('Full Send offers a separate protected Merge action after checks and keeps acceptance separate', async (t) => {
  const f = fixture(t);
  const guards = [];
  f.service.guard = (...args) => {
    guards.push(args);
    return humanGuard(...args);
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'ready-to-merge', record.summary);
  assert.equal(f.counts().merges, 0, 'Finishing implementation does not merge automatically.');
  await mergeReadyIssue(f);
  assert.equal(record.status, 'merged', record.summary);
  assert.equal(f.counts().merges, 1);
  const mergeGuard = guards.find(([, , operation]) => operation === 'merge');
  assert.match(mergeGuard[1].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(mergeGuard[1].id, record.work.runId);
  assert.equal(mergeGuard[1].worker_revision, record.work.verification.head);
  assert.equal(mergeGuard[3], record.work.readiness.target);
  assert.equal(readQueue(f.queue.root).issues[0].state, f.issue.state);
});

test('Full Send reaches merge through the installed human-input guard', async (t) => {
  const f = fixture(t);
  f.service.guard = humanGuard;
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'ready-to-merge');
  await mergeReadyIssue(f);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'merged', record.summary);
  assert.equal(f.counts().merges, 1);
  assert.equal(readQueue(f.queue.root).issues[0].state, f.issue.state);
});

test('Merge records GitHub success and leaves unfinished local target work untouched', async (t) => {
  const f = fixture(t);
  const unfinished = join(f.queue.root, 'unfinished-local-work.txt');
  writeFileSync(unfinished, 'keep this work');
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  await mergeReadyIssue(f);
  const view = strategyView(f.service, f.issue);
  assert.equal(view.status, 'merged');
  assert.equal(view.merge.revision, 'merge');
  assert.equal(view.localDevUpdate.status, 'not-updated');
  assert.match(view.localDevUpdate.reason, /unfinished work/);
  assert.equal(readFileSync(unfinished, 'utf8'), 'keep this work');
  assert.match(view.summary, /GitHub/);
  assert.match(view.summary, /Local main update needs attention/);
});

test('Full Send Merge checks the current run identity through the installed guard', async (t) => {
  const f = fixture(t);
  const guards = [];
  f.service.guard = (...args) => {
    guards.push(args);
    return humanGuard(...args);
  };
  const first = startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'ready-to-merge');
  const continued = startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.notEqual(continued.runId, first.runId);
  const record = f.service.lifecycleRuns[f.issue.id];
  await mergeReadyIssue(f);
  assert.equal(record.status, 'merged', record.summary);
  assert.equal(f.counts().merges, 1);
  assert.equal(f.counts().checks, 1, 'Continue reuses the unchanged checked PR');
  const mergeGuard = guards.findLast(([, , operation]) => operation === 'merge');
  assert.equal(mergeGuard[1].id, continued.runId, 'Continue binds permission to its newly authorized run');
});

test('Full Send merge guard rejects an invalid strategy identity through the human-input helper', async (t) => {
  const f = fixture(t);
  f.service.guard = (root, action, operation, target, ...rest) =>
    humanGuard(root, operation === 'merge' ? { ...action, id: f.issue.id } : action, operation, target, ...rest);
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  await assert.rejects(() => mergeReadyIssue(f), /Exact candidate tuple required/);
  assert.equal(record.status, 'ready-to-merge');
  assert.equal(f.counts().merges, 0);
});

test('Full Send merge guard still blocks a required human check', async (t) => {
  const f = fixture(t);
  const report = join(f.queue.root, '.issues/20261025-one.md');
  const original = readFileSync(report, 'utf8');
  f.service.guard = (root, action, operation, target, ...rest) => {
    if (operation === 'merge')
      writeFileSync(
        report,
        original.replace(
          'state: verify',
          `state: verify\nhuman_checks:\n  - id: required-review\n    kind: judgment\n    status: pending\n    instructions: Review the verified candidate.\n    blocks: dependent-work\n    revision: ${action.worker_revision}\n    result: null`
        )
      );
    return humanGuard(root, action, operation, target, ...rest);
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  await assert.rejects(() => mergeReadyIssue(f), /Human input blocks merge/);
  assert.equal(record.status, 'ready-to-merge');
  assert.equal(f.counts().merges, 0);
});

test('persistent failed checks stop after three repair approaches and preserve all evidence without merging', async (t) => {
  const f = fixture(t);
  f.service.check = async () => {
    throw Error('Required check failed');
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /Required check failed/);
  assert.equal(f.counts().calls, 4);
  assert.match(record.summary, /three repair approaches/);
  assert.equal(record.work.repairs[0].attempts.length, 3);
  assert.ok(existsSync(f.service.store.runs[0].repairEvidence));
  assert.equal(f.counts().merges, 0);
  assert.equal(git(record.work.checkout, 'status', '--porcelain'), '');
});

test('verification failure returns real evidence to the same owning chat, enforces Fallow and verifies the repaired candidate', async (t) => {
  const f = fixture(t);
  const prompts = [];
  const original = f.service.codex.turn;
  f.service.codex.turn = async (thread, cwd, prompt, ...args) => {
    prompts.push({ thread, prompt });
    return original(thread, cwd, prompt, ...args);
  };
  let checks = 0;
  const heads = [];
  const log = join(f.queue.root, 'failed-check.log');
  writeFileSync(log, 'actual failing test output');
  f.service.check = async (cwd, _base, _folder, options) => {
    assert.equal(options.auditPolicy, 'required');
    heads.push(git(cwd, 'rev-parse', 'HEAD'));
    if (++checks === 1)
      throw Object.assign(Error('Inherited publication-controls test failed.'), {
        verificationFailure: { logs: [log], summaries: [], blockerKey: 'publication-controls' },
      });
    return { head: heads.at(-1), passed: true };
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'ready-to-merge', record.summary);
  assert.equal(checks, 2);
  assert.notEqual(heads[0], heads[1]);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((entry) => entry.thread === 'owning-chat'));
  assert.match(prompts[1].prompt, /Inherited publication-controls/);
  assert.ok(prompts[1].prompt.includes(log));
  assert.equal(record.work.repairs[0].attempts.length, 1);
  assert.equal(record.work.blockerRepair.version, 1);
  assert.equal(f.counts().merges, 0);
});

test('readiness conflicts are repaired and old verification is never used for the changed candidate', async (t) => {
  const f = fixture(t);
  const provider = f.service.strategyProvider();
  const ready = provider.ready;
  let reads = 0;
  provider.ready = (...args) => {
    if (++reads === 1) throw repairableBlocker('target-conflict', 'Resolve target merge conflicts.');
    return ready(...args);
  };
  f.service.strategyProvider = () => provider;
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'handed-off');
  assert.deepEqual(f.counts(), { calls: 2, checks: 2, merges: 0 });
});

test('pending CI is observed without spending a code repair or repeating candidate verification', async (t) => {
  const f = fixture(t);
  const provider = f.service.strategyProvider();
  const ready = provider.ready;
  let observations = 0;
  provider.ready = (...args) => {
    if (++observations < 3) throw Object.assign(Error('PR checks are pending.'), { code: 'STRATEGY_PENDING' });
    return ready(...args);
  };
  f.service.strategyProvider = () => provider;
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'handed-off');
  assert.deepEqual(f.counts(), { calls: 1, checks: 1, merges: 0 });
  assert.equal(observations, 3);
});

test('a timed-out Merge action reconciles GitHub before retrying and records the local update separately', async (t) => {
  const f = fixture(t);
  const provider = f.service.strategyProvider();
  const ready = provider.ready;
  let merged = false;
  let writes = 0;
  provider.ready = (...args) => ({
    ...ready(...args),
    ...(merged ? { merged: true, merge: { url: 'merged-pr', revision: 'merged' } } : {}),
  });
  provider.merge = () => {
    writes++;
    merged = true;
    throw Object.assign(Error('ETIMEDOUT after merge'), { code: 'ETIMEDOUT' });
  };
  f.service.strategyProvider = () => provider;
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'ready-to-merge');
  await mergeReadyIssue(f);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'merged', record.summary);
  assert.equal(record.work.merge.revision, 'merged');
  assert.equal(writes, 1);
  assert.equal(f.counts().checks, 1);
  assert.equal(record.work.localDevUpdate.status, 'updated');
  assert.equal(record.events.at(-1).message.includes('Local main updated'), true);
});

test('repeating an approach stops and explicit Continue retains history without waking inactive work', async (t) => {
  const f = fixture(t);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    const result = JSON.parse(await owner(...args));
    if (result.repair) result.repair.approach = 'The same approach';
    return JSON.stringify(result);
  };
  f.service.check = async () => {
    throw Error('Required check failed');
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.match(record.summary, /repeated an earlier repair approach/);
  const previous = JSON.stringify(record.work.repairs);
  assert.equal(f.service.lifecycleTasks.size, 0);
  f.service.check = async (cwd) => ({ head: git(cwd, 'rev-parse', 'HEAD'), passed: true });
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'handed-off');
  assert.equal(JSON.stringify(record.work.repairs), previous);
});

test('strict strategy evidence rejects a previously skipped audit and a passing warning verdict', (t) => {
  const { input } = deliveryFixture(t);
  const summary = JSON.parse(readFileSync(input.verification[0]));
  const fallow = summary.checks.find((check) => check.name === 'fallow');
  const options = { auditPolicy: 'required' };
  validateSummary(summary, summary.base, summary.snapshot_tree, options);
  fallow.skipped = true;
  fallow.command = ['skipped'];
  assert.throws(() => validateSummary(summary, summary.base, summary.snapshot_tree, options), /enforced Fallow/);
  delete fallow.skipped;
  const raw = JSON.parse(readFileSync(fallow.log, 'utf8'));
  raw.verdict = 'warn';
  raw.attribution.gate = 'new-only';
  raw.attribution.complexity_introduced = 1;
  writeFileSync(fallow.log, JSON.stringify(raw));
  assert.throws(() => validateSummary(summary, summary.base, summary.snapshot_tree, options), /raw Fallow evidence/);
});

test('a repair with no committed change stops without repeating unchanged checks', async (t) => {
  const f = fixture(t);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (thread, cwd, prompt, ...args) =>
    prompt.includes('Required repair attempt:')
      ? JSON.stringify({
          outcome: 'completed',
          summary: 'No change',
          pr: null,
          remaining: [],
          repair: { approach: 'Observe again', evidence: [] },
        })
      : owner(thread, cwd, prompt, ...args);
  let checks = 0;
  f.service.check = async () => {
    checks++;
    throw Error('Required check failed');
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.match(f.service.lifecycleRuns[f.issue.id].summary, /no committed source change/);
  assert.equal(checks, 1);
});

test('explicit permission denial stops immediately without repair or infrastructure retries', async (t) => {
  const f = fixture(t);
  let checks = 0;
  f.service.check = async () => {
    checks++;
    throw Object.assign(Error('Permission denied by the user'), { code: 'EACCES' });
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.match(f.service.lifecycleRuns[f.issue.id].summary, /Permission denied/);
  assert.equal(f.counts().calls, 1);
  assert.equal(checks, 1);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.repairs, undefined);
});

test('an empty repair commit cannot masquerade as source progress or trigger unchanged verification', async (t) => {
  const f = fixture(t);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (thread, cwd, prompt, ...args) => {
    if (!prompt.includes('Required repair attempt:')) return owner(thread, cwd, prompt, ...args);
    git(cwd, 'commit', '--allow-empty', '-qm', 'empty repair');
    return JSON.stringify({
      outcome: 'completed',
      summary: 'Empty commit',
      pr: null,
      remaining: [],
      repair: { approach: 'Empty commit', evidence: [] },
    });
  };
  let checks = 0;
  f.service.check = async () => {
    checks++;
    throw Error('Required check failed');
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.match(f.service.lifecycleRuns[f.issue.id].summary, /no committed source change/);
  assert.equal(checks, 1);
});

test('temporary infrastructure failures receive only three delayed retries and never retry an explicit denial', async (t) => {
  const f = fixture(t);
  const record = { issueId: f.issue.id, events: [], work: {} };
  const delays = [];
  f.service.strategyDelay = async (ms) => delays.push(ms);
  let calls = 0;
  await assert.rejects(
    retryInfrastructure(f.service, record, async () => {
      calls++;
      throw Error('HTTP 503');
    }),
    /503/
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  calls = 0;
  await assert.rejects(
    retryInfrastructure(f.service, record, async () => {
      calls++;
      throw Error('HTTP 403 permission denied');
    }),
    /403/
  );
  assert.equal(calls, 1);
});

test('common DNS, connection and Git transport failures are retryable without disguising denied access', () => {
  for (const message of [
    'ENOTFOUND api.github.com',
    'ECONNREFUSED',
    'fatal: Could not resolve host: github.com',
    'Failed to connect to github.com port 443',
    'Operation timed out',
  ])
    assert.equal(infrastructureFailure(Error(message)), true, message);
  assert.equal(infrastructureFailure(Object.assign(Error('EACCES permission denied'), { transient: true })), false);
});

test('GitHub App authentication preserves retryable transport failures while rejecting actual access denials', async (t) => {
  const f = fixture(t);
  const record = { issueId: f.issue.id, events: [], work: {} };
  let requests = 0;
  const auth = new GitHubAppCredentials(
    { appId: 1, repository: 'fixture/timey', privateKey: 'unused' },
    'fixture/timey',
    {
      request: async () => {
        requests++;
        throw Object.assign(Error('fetch failed'), { cause: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }) });
      },
    }
  );
  await assert.rejects(
    retryInfrastructure(f.service, record, () => auth.api('app', 'unused')),
    /authentication request failed/
  );
  assert.equal(requests, 4);
  requests = 0;
  auth.request = async () => {
    requests++;
    return { ok: false, status: 403 };
  };
  await assert.rejects(
    retryInfrastructure(f.service, record, () => auth.api('app', 'unused')),
    /HTTP 403/
  );
  assert.equal(requests, 1);
  auth.request = async () => ({ ok: false, status: 503 });
  await assert.rejects(auth.api('app', 'unused'), (error) => error.transient === true);
});

test('GitHub App response-body failures retain safe diagnostics and bounded retries', async (t) => {
  const f = fixture(t);
  const record = { issueId: f.issue.id, events: [], work: {} };
  for (const [error, diagnostic] of [
    [Object.assign(Error('secret body'), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(Error('secret body'), { cause: { code: 'UND_ERR_SOCKET' } }), 'connection interrupted'],
    [new SyntaxError('secret body'), 'malformed JSON'],
  ]) {
    let requests = 0;
    const auth = new GitHubAppCredentials(
      { appId: 1, repository: 'fixture/timey', privateKey: 'unused' },
      'fixture/timey',
      {
        request: async () => {
          requests++;
          return {
            ok: true,
            status: 201,
            json: async () => {
              throw error;
            },
          };
        },
      }
    );
    await assert.rejects(
      retryInfrastructure(f.service, record, () => auth.api('app/installations/9/access_tokens', 'secret')),
      (failure) => {
        assert.equal(failure.transient, true);
        assert.ok(failure.message.includes('installation token'));
        assert.ok(failure.message.includes(diagnostic));
        assert.doesNotMatch(failure.message, /secret/);
        assert.equal(failure.cause, undefined);
        return true;
      }
    );
    assert.equal(requests, 4);
    auth.request = async () => ({ ok: true, json: async () => ({ id: 1 }) });
    assert.deepEqual(await auth.api('app', 'secret'), { id: 1 });
  }
});

test('repair after an externally merged PR uses a linked follow-up branch without replacing completed work', async (t) => {
  const f = fixture(t);
  const original = f.service.codex.turn;
  f.service.codex.turn = async (...args) => {
    const result = JSON.parse(await original(...args));
    if (!args[2].includes('Required repair attempt:')) {
      f.service.lifecycleRuns[f.issue.id].work.pr = 12;
      result.pr = 12;
    }
    return JSON.stringify(result);
  };
  const provider = f.service.strategyProvider();
  provider.publish = async () => ({ number: 13 });
  provider.inspect = (number) =>
    number === 12
      ? {
          merged_at: '2026-11-01T00:00:00Z',
          html_url: 'https://github.com/fixture/timey/pull/12',
          head: { ref: f.service.lifecycleRuns[f.issue.id].work.branch },
          base: { ref: 'main' },
        }
      : {};
  f.service.strategyProvider = () => provider;
  let checks = 0;
  f.service.check = async (cwd) => {
    if (++checks === 1) throw Error('Required check failed');
    return { head: git(cwd, 'rev-parse', 'HEAD'), passed: true };
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.match(record.work.branch, /^codex\/issue-1-repair-/);
  assert.match(record.work.branch, /-repair-/);
  assert.equal(record.work.pr, 13);
  assert.equal(record.work.followup.originalPr, 12);
  assert.equal(record.work.followup.status, 'ready');
  assert.ok(existsSync(join(record.work.checkout, 'change.js')));
});

test('an earlier issue resumes with a shared fix from a later merged PR and preserves conflicts for the owner', async (t) => {
  const upstream = gitFixture(t, 'strategy-upstream-');
  writeFileSync(join(upstream.root, 'feature.js'), 'export const value = 1;\n');
  upstream.git('add', '.');
  upstream.git('commit', '-qm', 'base');
  upstream.git('branch', '-M', 'main');
  const checkout = gitFixture(t, 'strategy-sync-');
  writeFileSync(join(checkout.root, '.git/info/exclude'), '.issues/\n');
  checkout.git('remote', 'add', 'origin', upstream.root);
  checkout.git('fetch', 'origin');
  checkout.git('checkout', '-b', 'codex/issue', 'origin/main');
  const service = { root: checkout.root, lifecycleRuns: {} };
  const record = {
    issueId: 'sync',
    events: [],
    work: { checkout: checkout.root, branch: 'codex/issue', config: { remote: 'origin', target: 'main' } },
  };
  writeFileSync(join(upstream.root, 'shared-fix.js'), 'export const earlierIssueFix = true;\n');
  upstream.git('add', '.');
  upstream.git('commit', '-qm', 'later issue PR #37 merges shared fix');
  assert.equal(await synchronizeStrategyTarget(service, record), true);
  assert.equal(await synchronizeStrategyTarget(service, record), false);
  assert.equal(readFileSync(join(checkout.root, 'shared-fix.js'), 'utf8'), 'export const earlierIssueFix = true;\n');
  writeFileSync(join(checkout.root, 'feature.js'), 'export const value = 2;\n');
  checkout.git('add', '.');
  checkout.git('commit', '-qm', 'issue side');
  writeFileSync(join(upstream.root, 'feature.js'), 'export const value = 3;\n');
  upstream.git('add', '.');
  upstream.git('commit', '-qm', 'target side');
  await assert.rejects(synchronizeStrategyTarget(service, record), (error) => error.code === 'target-conflict');
  assert.ok(checkout.git('ls-files', '-u').includes('feature.js'));
  assert.equal(checkout.git('branch', '--show-current'), 'codex/issue');
  assert.equal(upstream.git('show', 'main:feature.js'), 'export const value = 3;');
});

test('Fixed closure shows the saved strategy failure while obsolete closure cancels and retains its work', async (t) => {
  const f = fixture(t);
  f.service.codex.turn = async () =>
    JSON.stringify({
      outcome: 'blocked',
      summary: 'Opened PR #33, but the required GitHub test check failed.',
      pr: 33,
      remaining: ['test:factory passed 621/622 tests; publication-controls expected one control but found two.'],
    });
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  const before = readFileSync(join(f.queue.root, '.issues', f.issue.id + '.md'), 'utf8');
  const saved = JSON.stringify(record);
  const calls = f.counts();
  const queue = readQueue(f.queue.root);
  const issue = queue.issues[0];
  const basis = decisionBasis(queue, issue);
  assert.throws(
    () => f.service.decideIssue(issue.id, issue.state, 'close', basis),
    (error) => {
      assert.match(error.message, /PR #33/);
      assert.match(error.message, /test:factory passed 621\/622/);
      assert.match(error.message, /Close with reason/);
      return true;
    }
  );
  assert.equal(readFileSync(join(f.queue.root, '.issues', f.issue.id + '.md'), 'utf8'), before);
  assert.equal(JSON.stringify(record), saved);
  assert.deepEqual(f.counts(), calls, 'Closure must not run checks, AI work or merges.');
  const closed = f.service.decideIssue(issue.id, issue.state, 'close', basis, 'Superseded by other work.', 'obsolete');
  assert.equal(closed.state, 'closed');
  const result = readQueue(f.queue.root).issues[0];
  assert.equal(result.closure.reason, 'obsolete');
  assert.equal(result.accepted_result, undefined);
  assert.notEqual(JSON.stringify(record), saved);
  assert.equal(record.status, 'cancelled');
  assert.equal(record.work.implementation.outcome, 'blocked');
  assert.match(record.events.at(-1).message, /Stopped issue action cancelled/);
  assert.deepEqual(f.counts(), calls);
});

test('start requires current scope and explicit strategy permission; selecting or reading never runs work', (t) => {
  const f = fixture(t);
  assert.equal(strategyView(f.service, f.issue).strategy, 'full-stop');
  assert.deepEqual(f.counts(), { calls: 0, merges: 0, checks: 0 });
  assert.throws(() => startIssueStrategy(f.service, { ...f.input(), approved: false }), /Explicitly start/);
  assert.throws(() => startIssueStrategy(f.service, { ...f.input(), basis: 'stale' }), /issue or strategy changed/);
  assert.throws(() => startIssueStrategy(f.service, { ...f.input(), solRounds: 20 }), /three rounds/);
  assert.equal(f.service.store.runs.length, 0);
});

test('a new issue starts from freshly fetched target while preserving main checkout commits', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.queue.root, 'unpublished.js'), 'export const privateWork = true;\n');
  git(f.queue.root, 'add', 'unpublished.js');
  git(f.queue.root, 'commit', '-qm', 'unpublished coordinator work');
  const coordinatorHead = git(f.queue.root, 'rev-parse', 'HEAD');

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  const work = f.service.lifecycleRuns[f.issue.id].work;
  const target = git(f.queue.root, 'rev-parse', 'refs/remotes/origin/main');
  assert.equal(work.base, target);
  assert.equal(git(work.checkout, 'merge-base', 'HEAD', target), target);
  assert.equal(git(work.checkout, 'branch', '--show-current'), work.branch);
  assert.equal(existsSync(join(work.checkout, 'unpublished.js')), false);
  assert.equal(git(f.queue.root, 'rev-parse', 'HEAD'), coordinatorHead);
  assert.equal(readFileSync(join(f.queue.root, 'unpublished.js'), 'utf8'), 'export const privateWork = true;\n');
});

test('a new issue excludes unapproved coordinator commits and preserves the main checkout', async (t) => {
  const f = fixture(t);
  const target = git(f.queue.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.queue.root, 'earlier-fix.js'), 'export const earlier = true;\n');
  git(f.queue.root, 'add', 'earlier-fix.js');
  git(f.queue.root, 'commit', '-qm', 'Fix a separate issue');
  const earlier = git(f.queue.root, 'rev-parse', 'HEAD');
  f.service.strategySyncTarget = async (work) => {
    work.targetRevision = target;
    return false;
  };
  const provider = f.service.strategyProvider();
  const ready = provider.ready;
  provider.ready = async (...args) => ({ ...(await ready(...args)), target });
  f.service.strategyProvider = () => provider;

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.ok(record.work.startingInclusion.commits.some((commit) => commit.revision === earlier));
  assert.equal(existsSync(join(record.work.checkout, 'earlier-fix.js')), false);
  assert.equal(f.counts().calls, 1);
  assert.equal(git(f.queue.root, 'rev-parse', 'HEAD'), earlier);
});

test('an explicit commit-specific dependency reason permits intended earlier work', async (t) => {
  const f = fixture(t);
  const target = git(f.queue.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.queue.root, 'shared-contract.js'), 'export const contract = true;\n');
  git(f.queue.root, 'add', 'shared-contract.js');
  git(f.queue.root, 'commit', '-qm', 'Add a shared contract');
  const dependency = git(f.queue.root, 'rev-parse', 'HEAD');
  f.service.strategySyncTarget = async (work) => {
    work.targetRevision = target;
    return false;
  };
  const provider = f.service.strategyProvider();
  const ready = provider.ready;
  provider.ready = async (...args) => ({ ...(await ready(...args)), target });
  f.service.strategyProvider = () => provider;
  const input = f.input();
  input.instruction = `Include commit ${dependency} intentionally: This contract is required by the selected issue.`;

  startIssueStrategy(f.service, input);
  await f.service.lifecycleTasks.get(f.issue.id);

  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.equal(record.work.startingInclusion.included[0].source, dependency);
  assert.match(record.work.startingInclusion.included[0].reason, /required by the selected issue/);
  assert.equal(record.work.inclusionCheck.phase, 'PR publication');
  assert.equal(f.counts().calls, 1);
});

test('an existing dirty issue checkout is preserved and reported before work starts', async (t) => {
  const f = fixture(t);
  const issueWork = join(f.queue.root, '.issues/issue-work');
  mkdirSync(issueWork, { recursive: true });
  const checkout = join(issueWork, f.issue.id);
  const base = git(f.queue.root, 'rev-parse', 'HEAD');
  const branch = `codex/issue-${f.issue.id}`;
  git(f.queue.root, 'worktree', 'add', '-b', branch, checkout, base);
  writeFileSync(join(checkout, 'saved-work.js'), 'export const saved = true;\n');
  f.service.lifecycleRuns[f.issue.id] = {
    id: 'prior-run',
    issueId: f.issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
    work: {
      checkout,
      branch,
      base,
      config: { provider: 'github', repository: 'fixture/timey', remote: 'origin', target: 'main' },
    },
  };
  f.service.strategySyncTarget = async (work) => {
    work.targetRevision = base;
    return false;
  };

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /uncommitted changes/);
  assert.match(record.summary, /saved-work\.js/);
  assert.equal(readFileSync(join(checkout, 'saved-work.js'), 'utf8'), 'export const saved = true;\n');
  assert.equal(f.counts().calls, 0);
  assert.ok(existsSync(record.work.inclusionCheck.evidencePath));
});

test('an existing issue checkout on a different branch stops with the expected and actual branch', async (t) => {
  const f = fixture(t);
  const issueWork = join(f.queue.root, '.issues/issue-work');
  mkdirSync(issueWork, { recursive: true });
  const checkout = join(issueWork, f.issue.id);
  const base = git(f.queue.root, 'rev-parse', 'HEAD');
  const expectedBranch = `codex/issue-${f.issue.id}`;
  const actualBranch = 'codex/fix-another-issue';
  git(f.queue.root, 'worktree', 'add', '-b', actualBranch, checkout, base);
  f.service.lifecycleRuns[f.issue.id] = {
    id: 'prior-run',
    issueId: f.issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
    work: {
      checkout,
      branch: expectedBranch,
      base,
      config: { provider: 'github', repository: 'fixture/timey', remote: 'origin', target: 'main' },
    },
  };

  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);

  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, new RegExp(expectedBranch));
  assert.match(record.summary, new RegExp(actualBranch));
  assert.match(record.summary, /No work was started/);
  assert.equal(f.counts().calls, 0);
});

test('an existing active assignment is not replaced by a strategy worker', (t) => {
  const f = fixture(t);
  f.service.store.connected.add('existing');
  f.service.store.runs.push({ id: 'existing', issueId: f.issue.id });
  assert.throws(() => startIssueStrategy(f.service, f.input()), /still connected/);
  assert.equal(f.counts().calls, 0);
});

function providerFixture() {
  const config = { repository: 'fixture/timey', target: 'main' };
  const provider = new StrategyProvider('.', config, join(tmpdir(), 'timey-provider-fixture-no-credentials'));
  provider.credentials = null;
  const pr = {
    number: 12,
    user: { login: 'fixture' },
    state: 'open',
    mergeable: true,
    draft: false,
    head: { ref: 'codex/issue-one', sha: 'head', repo: { full_name: config.repository } },
    base: { ref: 'main', sha: 'base', repo: { full_name: config.repository } },
    html_url: 'https://github.com/fixture/timey/pull/12',
  };
  const commands = [];
  let strict = true,
    admin = true,
    queued = false,
    clean = true,
    reviewDecision = null,
    bypass = 'always',
    classicReviews = false,
    conclusion = 'SUCCESS',
    reviewRules = [
      { type: 'required_status_checks', ruleset_id: 42 },
      { type: 'pull_request', ruleset_id: 43 },
    ];
  provider.gh = (args) => {
    commands.push(args);
    if (args.includes('graphql'))
      return JSON.stringify({
        data: { repository: { pullRequest: { mergeQueueEntry: queued ? { id: 'queue' } : null } } },
      });
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({
        reviewDecision,
        mergeStateStatus: clean ? 'CLEAN' : 'BLOCKED',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion }],
      });
    if (args[1] === 'user') return JSON.stringify({ login: 'fixture' });
    if (args[1]?.includes('/rules/branches/')) return JSON.stringify([reviewRules]);
    if (args[1]?.endsWith('/rulesets/42'))
      return JSON.stringify({
        id: 42,
        enforcement: 'active',
        current_user_can_bypass: admin ? 'never' : 'always',
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: strict,
              required_status_checks: [{ context: 'verify' }],
            },
          },
        ],
      });
    if (args[1]?.endsWith('/rulesets/43'))
      return JSON.stringify({
        id: 43,
        enforcement: 'active',
        current_user_can_bypass: bypass,
        rules: [],
      });
    if (args[1]?.endsWith('/merge')) return JSON.stringify({ merged: true, sha: 'merged' });
    if (args[1] === 'repos/fixture/timey') return JSON.stringify({ allow_squash_merge: true });
    if (args[1]?.endsWith('/protection'))
      return JSON.stringify({ required_pull_request_reviews: classicReviews ? {} : null });
    return '{}';
  };
  return {
    provider,
    pr,
    commands,
    change: (options) => {
      if ('strict' in options) strict = options.strict;
      if ('admin' in options) admin = options.admin;
      if ('queued' in options) queued = options.queued;
      if ('clean' in options) clean = options.clean;
      if ('reviewDecision' in options) reviewDecision = options.reviewDecision;
      if ('bypass' in options) bypass = options.bypass;
      if ('classicReviews' in options) classicReviews = options.classicReviews;
      if ('conclusion' in options) conclusion = options.conclusion;
      if ('reviewRules' in options) reviewRules = options.reviewRules;
    },
  };
}
test('live readiness rejects draft, changed head, queue enrollment, failing checks and wrong repository', async () => {
  const f = providerFixture();
  assert.equal((await f.provider.ready(f.pr, 'codex/issue-one', 'head')).head, 'head');
  await assert.rejects(() => f.provider.ready({ ...f.pr, draft: true }, 'codex/issue-one', 'head'), /non-draft/);
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'other'), /candidate changed/);
  await assert.rejects(
    () => f.provider.ready({ ...f.pr, base: { ...f.pr.base, ref: 'other' } }, 'codex/issue-one', 'head'),
    /target changed/
  );
  f.change({ queued: true });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /merge queue/);
  f.change({ queued: false, clean: false });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /unfinished checks/);
});

test('readiness reconciles an externally merged candidate using the latest check attempt without hiding other checks', async () => {
  const f = providerFixture();
  Object.assign(f.pr, { merged_at: 'now', merge_commit_sha: 'merged', state: 'closed', mergeable: false });
  const gh = f.provider.gh;
  const checks = [
    {
      __typename: 'CheckRun',
      name: 'test',
      workflowName: 'Verify',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      startedAt: '2026-11-01T00:00:00Z',
    },
    {
      __typename: 'CheckRun',
      name: 'test',
      workflowName: 'Verify',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: '2026-11-02T00:00:00Z',
    },
  ];
  f.provider.gh = (args) => (args[0] === 'pr' ? JSON.stringify({ statusCheckRollup: checks }) : gh(args));
  const result = await f.provider.ready(f.pr, 'codex/issue-one', 'head');
  assert.equal(result.merged, true);
  assert.equal(result.merge.revision, 'merged');
  checks.push({ __typename: 'CheckRun', name: 'security', status: 'COMPLETED', conclusion: 'FAILURE' });
  await assert.rejects(f.provider.ready(f.pr, 'codex/issue-one', 'head'), (error) => error.code === 'ci-failure');
});
test('the Merge action requires an approving GitHub review for the exact PR head', async () => {
  const f = providerFixture();
  let reviewDecision = 'APPROVED';
  let headRefOid = 'head';
  f.provider.gh = async () => JSON.stringify({ reviewDecision, headRefOid });
  await f.provider.assertApproved(12, 'head');
  headRefOid = 'new-head';
  await assert.rejects(() => f.provider.assertApproved(12, 'head'), /head changed/);
  headRefOid = 'head';
  reviewDecision = 'REVIEW_REQUIRED';
  await assert.rejects(() => f.provider.assertApproved(12, 'head'), /approving review/);
});

test('Full Send refuses unsafe protection and uses an exact-head merge without bypass or auto-merge', async () => {
  const f = providerFixture();
  f.change({ strict: false });
  await assert.rejects(() => f.provider.merge(12, 'head'), /strict required checks/);
  f.change({ strict: true, admin: false });
  await assert.rejects(() => f.provider.merge(12, 'head'), /administrators/);
  f.change({ admin: true });
  f.provider.inspect = () => ({ ...f.pr, merged_at: 'now', merge_commit_sha: 'merged' });
  assert.equal((await f.provider.merge(12, 'head')).revision, 'merged');
  const args = f.commands.find((command) => command[1]?.endsWith('/merge'));
  assert.ok(args.includes('sha=head'));
  assert.ok(args.includes('merge_method=squash'));
  assert.ok(args.includes('PUT'));
  assert.ok(!args.includes('--admin'));
  assert.ok(!args.includes('--auto'));
});
test('owner-authored PR respects its verified ruleset review bypass without bypassing CI', async () => {
  const f = providerFixture();
  f.change({ reviewDecision: 'REVIEW_REQUIRED', clean: false });
  assert.equal((await f.provider.ready(f.pr, 'codex/issue-one', 'head')).head, 'head');
  f.change({ bypass: 'never' });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /required human review/);
  f.change({ bypass: 'always', classicReviews: true });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /required human review/);
  f.change({ classicReviews: false, strict: false });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /strict required checks/);
  f.change({ strict: true, admin: false });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /administrators/);
  f.change({ admin: true, reviewDecision: 'CHANGES_REQUESTED' });
  await assert.rejects(
    () => f.provider.ready(f.pr, 'codex/issue-one', 'head'),
    (error) => error.code === 'review-findings'
  );
  f.change({ reviewDecision: 'REVIEW_REQUIRED' });
  await assert.rejects(
    () => f.provider.ready({ ...f.pr, user: { login: 'another' } }, 'codex/issue-one', 'head'),
    /required human review/
  );
  f.change({ conclusion: 'FAILURE' });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /pending or failed/);
  f.change({ conclusion: 'SUCCESS', reviewRules: [{ type: 'required_status_checks', ruleset_id: 42 }] });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /required human review/);
  f.change({
    reviewRules: [
      { type: 'required_status_checks', ruleset_id: 42 },
      { type: 'pull_request', ruleset_id: 43 },
      { type: 'pull_request', ruleset_id: 44 },
    ],
  });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /required human review/);
  assert.ok(!f.commands.some((args) => args[1]?.endsWith('/merge')));
});
test('Sol Loop is optional and unavailable Sol never silently substitutes a model', async () => {
  const service = { codex: { ready: async () => {}, call: async () => ({ data: [{ id: 'other' }] }) } };
  await assert.rejects(
    runSolLoop(service, { work: {} }, {}, {}, () => {
      throw Error('Must not start owner');
    }),
    /no Sol model/
  );
  const prompt = strategyPrompt('/repo', { id: 'one' }, { strategy: 'full-stop', config: {}, solRounds: 0 });
  assert.match(prompt, /Sol Loop was not selected/);
  assert.match(prompt, /Never merge/);
});

test('missing Full Send enforcement blocks before creating a checkout or starting an AI turn', async (t) => {
  const f = fixture(t);
  f.service.strategyProvider = () => ({
    assertMergeProtection: async () => {
      throw Error('Protection is unavailable');
    },
  });
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.equal(record.work.checkout, undefined);
  assert.equal(f.counts().calls, 0);
});

test('optional Sol review can run after Full Stop without repeating implementation', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const owner = f.service.codex.turn;
  let reviews = 0;
  f.service.codex.start = async () => 'sol-review-chat';
  const call = f.service.codex.call;
  f.service.codex.call = async (method, params) =>
    method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol' }] } : call(method, params);
  f.service.codex.turn = async (thread, cwd, prompt, schema, extra, settings) => {
    if (thread === 'sol-review-chat') {
      reviews++;
      assert.equal(settings.model, 'gpt-6.1-sol');
      return JSON.stringify({ verdict: 'approve', summary: 'Scoped change approved', findings: [] });
    }
    return owner(thread, cwd, prompt, schema, extra, settings);
  };
  startIssueStrategy(f.service, { ...f.input(), operation: 'review', solRounds: 3 });
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.equal(reviews, 1);
  assert.equal(record.workThreadId, 'owning-chat');
  assert.equal(f.counts().calls, 1, 'No new implementation turn is needed for an approved saved candidate');
  assert.equal(record.work.review.rounds, 1);
});

test('Sol budget exhaustion retains findings and stops rather than inventing approval or extra rounds', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const owner = f.service.codex.turn;
  f.service.codex.start = async () => 'sol-review-chat';
  const call = f.service.codex.call;
  f.service.codex.call = async (method, params) =>
    method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol' }] } : call(method, params);
  let reviews = 0;
  f.service.codex.turn = async (thread, cwd, prompt, schema, extra, settings) => {
    if (thread === 'sol-review-chat') {
      reviews++;
      return JSON.stringify({
        verdict: 'changes',
        summary: 'A scoped bug remains',
        findings: [{ id: 'S1', severity: 'should', detail: 'Fix the actual intended case.' }],
      });
    }
    return owner(thread, cwd, prompt, schema, extra, settings);
  };
  startIssueStrategy(f.service, { ...f.input(), operation: 'review', solRounds: 1 });
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /round budget/);
  assert.equal(reviews, 1);
  assert.equal(f.counts().merges, 0);
  assert.ok(existsSync(record.work.review.ledger));
});

test('Sol findings in a newly created issue chat resume its owner rather than replaying chat startup', async (t) => {
  const f = fixture(t);
  const start = f.service.codex.start;
  f.service.codex.start = async (...args) => (args[1] === 'read-only' ? 'sol-review-chat' : start(...args));
  const call = f.service.codex.call;
  f.service.codex.call = async (method, ...args) =>
    method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol' }] } : call(method, ...args);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (thread, ...args) =>
    thread === 'sol-review-chat'
      ? JSON.stringify({
          verdict: 'changes',
          summary: 'A scoped finding',
          findings: [{ id: 'S1', severity: 'should', detail: 'Fix it.' }],
        })
      : owner(thread, ...args);
  startIssueStrategy(f.service, { ...f.input(), solRounds: 1 });
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.match(record.summary, /round budget/);
  assert.equal(f.counts().calls, 2);
  assert.equal(record.workThreadId, 'owning-chat');
  assert.equal(f.counts().merges, 0);
});

test('No new actions pauses a Full Send before merge even if readiness just became available', async (t) => {
  const f = fixture(t);
  let merges = 0;
  f.service.strategyProvider = () => ({
    assertMergeProtection: async () => true,
    publish: async () => ({ number: 12 }),
    inspect: () => ({}),
    ready: (_pr, _branch, head) => {
      f.service.lifecycleRuns[f.issue.id].pauseRequested = true;
      return { head, number: 12, url: 'https://github.com/fixture/timey/pull/12', target: 'base' };
    },
    merge: () => {
      merges++;
    },
  });
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'paused');
  assert.equal(merges, 0);
});

test('comments during strategy work save feedback without starting another writer or chat', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input());
  const response = await f.service.issueChats.send({
    issueId: f.issue.id,
    id: 'during-work',
    mode: 'comment',
    text: 'Keep the existing behavior.',
  });
  assert.match(response.disposition, /No competing response/);
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.counts().calls, 1);
  assert.equal(f.service.issueChats.connections.size, 0);
});

test('strategy execution replaces discussion-only instructions in the same writable chat', async (t) => {
  const f = fixture(t);
  saveConversationState(f.queue.root, f.issue.id, {
    threadId: 'discussion-chat',
    status: 'idle',
  });
  const resumes = [];
  f.service.codex.start = async () => assert.fail('The existing issue chat must be reused.');
  f.service.codex.resume = async (...args) => resumes.push(args);
  const owner = f.service.codex.turn;
  f.service.codex.turn = async (thread, cwd, prompt, ...args) => {
    assert.equal(thread, 'discussion-chat');
    assert.deepEqual(resumes.at(-1), [thread, cwd, 'workspace-write']);
    assert.match(prompt, /Earlier discussion-only instructions apply only to their original turns/);
    assert.match(prompt, /This is the explicit factory handler for implementation and PR operations/);
    assert.match(prompt, /Backlog and empty lifecycle history do not block this authorized strategy/);
    assert.match(prompt, /Never override an actual sandbox restriction or permission denial/);
    return owner(thread, cwd, prompt, ...args);
  };
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'handed-off', record.summary);
  assert.equal(record.workThreadId, 'discussion-chat');
  assert.equal(f.counts().calls, 1);
  assert.equal(f.counts().merges, 0);
});

test('Reply and continue explicitly resumes the same strategy and owning chat', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  const firstChat = record.workThreadId;
  await assert.rejects(
    f.service.issueChats.send({
      issueId: f.issue.id,
      id: 'stale-reply',
      mode: 'answer',
      updated: 'old',
      text: 'Continue.',
    }),
    /strategy changed/
  );
  const response = await f.service.issueChats.send({
    issueId: f.issue.id,
    id: 'explicit-reply',
    mode: 'answer',
    updated: record.updated,
    text: 'Keep the existing scope and finish the PR.',
  });
  assert.equal(response.accepted, true);
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].workThreadId, firstChat);
  assert.equal(f.service.lifecycleRuns[f.issue.id].status, 'handed-off');
  assert.equal(f.counts().calls, 2);
  assert.equal(f.counts().merges, 0);
});

test('installation credentials sign JWTs, restrict repository, share refresh and renew expiring tokens', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'timey-app-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(directory, 'key.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  let time = 1000000000000,
    minted = 0;
  const auth = new GitHubAppCredentials(
    { appId: 5, repository: 'fixture/timey', privateKeyPath: keyPath },
    'fixture/timey',
    {
      now: () => time,
      request: async (url, options) => {
        const jwt = options.headers.Authorization.slice(7);
        const [header, payload, signature] = jwt.split('.');
        assert.ok(
          verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url'))
        );
        const claims = JSON.parse(Buffer.from(payload, 'base64url'));
        assert.equal(claims.iss, '5');
        assert.equal(claims.iat, Math.floor(time / 1000) - 60);
        if (url.endsWith('/app')) return { ok: true, json: async () => ({ id: 5, slug: 'factory' }) };
        if (url.endsWith('/installation')) return { ok: true, json: async () => ({ id: 9, app_id: 5 }) };
        assert.equal(url, 'https://api.github.com/app/installations/9/access_tokens');
        assert.deepEqual(JSON.parse(options.body), { repositories: ['timey'] });
        minted++;
        return {
          ok: true,
          json: async () => ({ token: 'secret-' + minted, expires_at: new Date(time + 3600000).toISOString() }),
        };
      },
    }
  );
  const [first, second] = await Promise.all([auth.session(), auth.session()]);
  assert.equal(first.token, second.token);
  assert.equal(minted, 1);
  time += 3550000;
  assert.notEqual((await auth.session()).token, first.token);
  assert.equal(minted, 2);
  const failing = new GitHubAppCredentials(auth.config, 'fixture/timey', {
    request: async () => {
      throw Error('secret-token');
    },
  });
  await assert.rejects(
    () => failing.session(),
    (e) => e.message === 'GitHub App authentication request failed.'
  );
  assert.throws(() => new GitHubAppCredentials(auth.config, 'other/repo'), /different repository/);
});

test('installation credentials can be loaded from server environment settings', (t) => {
  const names = [
    'TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID',
    'TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY',
    'TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID = '5';
  process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----';
  process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID = '9';
  const credentials = githubAppCredentials('/tmp/project', 'fixture/timey');
  assert.equal(credentials.config.appId, 5);
  assert.equal(credentials.config.installationId, 9);
  assert.equal(credentials.config.repository, 'fixture/timey');
  assert.equal(credentials.config.privateKey, '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----');
});

test('factory app honors review bypass without user identity endpoint or CI bypass', async () => {
  const f = providerFixture();
  f.provider.credentials = { session: async () => ({ slug: 'factory' }) };
  f.change({ bypass: 'pull_requests_only' });
  f.change({ reviewDecision: 'REVIEW_REQUIRED', clean: false });
  assert.equal((await f.provider.ready(f.pr, 'codex/issue-one', 'head')).head, 'head');
  assert.ok(!f.commands.some((args) => args[1] === 'user'));
  f.change({ admin: false });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /prevent this credential/);
});
