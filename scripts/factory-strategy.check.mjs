import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { git, writeJson } from './factory-ui/common.mjs';
import { strategyView, startIssueStrategy } from './factory-ui/issue-strategy.mjs';
import { GitHubAppCredentials, githubAppCredentials } from './factory-ui/github-app.mjs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.throws(() => startIssueStrategy(f.service, f.input('full-send')), /saved issue strategy/);
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
  const provider = new StrategyProvider('.', config, join(tmpdir(), 'timey-provider-fixture-no-credentials'));
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
  await assert.rejects(() => f.provider.ready(f.pr, 'codex/issue-one', 'head'), /required human review/);
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
  process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----';
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
