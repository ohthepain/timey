import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { git, writeJson } from './factory-ui/common.mjs';
import { strategyView, startIssueStrategy } from './factory-ui/issue-strategy.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { strategyPrompt } from './factory-ui/strategy-prompt.mjs';
import { runSolLoop } from './factory-ui/strategy-review.mjs';

function fixture(t) {
  const { queue } = deliveryFixture(t);
  writeJson(join(queue.root, '.issues/issue-delivery-config.json'), {
    provider: 'github',
    repository: 'fixture/timey',
    remote: 'origin',
    target: 'main',
  });
  const service = new FactoryUI(queue.root);
  t.after(() => service.close());
  service.ownServer = () => {};
  service.guard = () => [];
  let calls = 0,
    merges = 0,
    checks = 0;
  service.codex.start = async (_cwd, _sandbox, retain) => {
    retain?.({ status: 'ready', threadId: 'owning-chat' });
    return 'owning-chat';
  };
  service.codex.resume = async () => {};
  service.codex.ready = async () => {};
  service.codex.call = async (method) => (method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : {});
  service.codex.turn = async (_thread, cwd, prompt) => {
    calls++;
    assert.match(prompt, /No lifecycle roles or stage transitions/);
    assert.match(prompt, /Never push the target branch/);
    assert.equal(cwd, service.lifecycleRuns['20261025-one'].work.checkout);
    if (!existsSync(join(cwd, 'change.js'))) {
      writeFileSync(join(cwd, 'change.js'), 'export const changed = true;\n');
      git(cwd, 'add', 'change.js');
      git(cwd, 'commit', '-qm', 'issue implementation');
    }
    return JSON.stringify({ outcome: 'completed', summary: 'Ready for handoff', pr: 12, remaining: [] });
  };
  service.check = async (cwd) => {
    checks++;
    return { head: git(cwd, 'rev-parse', 'HEAD'), passed: true };
  };
  service.strategyProvider = () => ({
    assertMergeProtection: async () => true,
    inspect: () => ({}),
    ready: (_pr, _branch, head) => ({
      head,
      number: 12,
      url: 'https://github.com/fixture/timey/pull/12',
      target: queue.git('rev-parse', 'HEAD'),
    }),
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
  return { queue, service, issue, input, counts: () => ({ calls, merges, checks }) };
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
  startIssueStrategy(f.service, f.input());
  await f.service.lifecycleTasks.get(f.issue.id);
  assert.equal(f.service.lifecycleRuns[f.issue.id].work.checkout, checkout);
  assert.equal(f.service.lifecycleRuns[f.issue.id].workThreadId, 'owning-chat');
});

test('Full Send uses the protected provider after checks and keeps acceptance separate', async (t) => {
  const f = fixture(t);
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'merged', record.summary);
  assert.equal(f.counts().merges, 1);
  assert.equal(readQueue(f.queue.root).issues[0].state, f.issue.state);
});

test('failed checks preserve the candidate and stop without publication readiness, merge or retry', async (t) => {
  const f = fixture(t);
  f.service.check = async () => {
    throw Error('Required check failed');
  };
  startIssueStrategy(f.service, f.input('full-send'));
  await f.service.lifecycleTasks.get(f.issue.id);
  const record = f.service.lifecycleRuns[f.issue.id];
  assert.equal(record.status, 'blocked');
  assert.match(record.summary, /Required check failed/);
  assert.equal(f.counts().calls, 1);
  assert.equal(f.counts().merges, 0);
  assert.equal(git(record.work.checkout, 'status', '--porcelain'), '');
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

test('an existing active assignment is not replaced by a strategy worker', (t) => {
  const f = fixture(t);
  f.service.store.connected.add('existing');
  f.service.store.runs.push({ id: 'existing', issueId: f.issue.id });
  assert.throws(() => startIssueStrategy(f.service, f.input()), /still connected/);
  assert.equal(f.counts().calls, 0);
});

function providerFixture() {
  const config = { repository: 'fixture/timey', target: 'main' };
  const provider = new StrategyProvider('.', config);
  const pr = {
    number: 12,
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
    clean = true;
  provider.gh = (args) => {
    commands.push(args);
    if (args.includes('graphql'))
      return JSON.stringify({
        data: { repository: { pullRequest: { mergeQueueEntry: queued ? { id: 'queue' } : null } } },
      });
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({
        mergeStateStatus: clean ? 'CLEAN' : 'BLOCKED',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
    if (args[1]?.endsWith('/merge')) return JSON.stringify({ merged: true, sha: 'merged' });
    if (args[1] === 'repos/fixture/timey') return JSON.stringify({ allow_squash_merge: true });
    if (args[1]?.endsWith('/protection'))
      return JSON.stringify({
        required_status_checks: { strict, contexts: ['verify'] },
        enforce_admins: { enabled: admin },
      });
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
    },
  };
}
test('live readiness rejects draft, changed head, queue enrollment, failing checks and wrong repository', async () => {
  const f = providerFixture();
  assert.equal((await f.provider.ready(f.pr, 'codex/issue-one', 'head')).head, 'head');
  await assert.rejects(() => f.provider.ready({ ...f.pr, draft: true }, 'codex/issue-one', 'head'), /non-draft/);
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'other'), /candidate changed/);
  f.change({ queued: true });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /merge queue/);
  f.change({ queued: false, clean: false });
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /unfinished checks/);
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

test('No new actions pauses a Full Send before merge even if readiness just became available', async (t) => {
  const f = fixture(t);
  let merges = 0;
  f.service.strategyProvider = () => ({
    assertMergeProtection: async () => true,
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
