import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { importBrowserIssue, installBrowserHumanInput } from './flow-browser-fixture.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';

const issueId = '20261127T064500590-06db268f17bada52';
const title = 'Complete the two outstanding live checks for #282 and #291';
const repository = 'test/fixture';
const target = 'factory-proof/291-target';
const advance = { number: 2901, branch: 'factory-proof/291-advance', head: 'a'.repeat(40) };
const advanced = 'b'.repeat(40);
const updated = 'c'.repeat(40);
const merged = 'd'.repeat(40);
const verificationPR = 2902;
const scopeFor = (branch, targetHead) => ({
  operation: 'full-send-late-target',
  reason: 'Investigate cannot perform the GitHub writes needed by #291 Full Send after a late target advance.',
  repository,
  branch,
  target,
  targetHead,
  advance,
});

function fixtureProvider(project, config, scope, candidate, writes) {
  const provider = new StrategyProvider(project, config);
  provider.credentials = { session: async () => ({ slug: 'fixture' }) };
  const repo = { full_name: repository };
  const pull = (number, branch, sha) => ({
    number,
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    html_url: 'https://github.com/' + repository + '/pull/' + number,
    base: { ref: target, repo },
    head: { ref: branch, sha, repo },
  });
  const prs = new Map([[advance.number, pull(advance.number, advance.branch, advance.head)]]);
  const check = { __typename: 'StatusContext', context: 'Verify', state: 'SUCCESS', isRequired: true };
  const rule = {
    type: 'required_status_checks',
    ruleset_id: 42,
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'Verify' }],
    },
  };
  let targetHead = scope.targetHead;
  const merge = (number, args) => {
    const pr = prs.get(number);
    assert.deepEqual(args, ['--method', 'PUT', '-f', 'sha=' + pr.head.sha, '-f', 'merge_method=merge']);
    if (number === verificationPR && pr.head.sha === candidate.head) {
      assert.equal(targetHead, advanced);
      pr.mergeable_state = 'behind';
      throw Object.assign(Error('GitHub rejected the stale PR (HTTP 405).'), { githubStatus: 405 });
    }
    targetHead = number === advance.number ? advanced : merged;
    Object.assign(pr, { state: 'closed', merged_at: '2026-11-27T09:00:00Z', merge_commit_sha: targetHead });
    return { merged: true, sha: targetHead };
  };
  const responses = new Map([
    ['', () => ({ full_name: repository, default_branch: 'dev', allow_merge_commit: true })],
    ['/branches/' + encodeURIComponent(target), () => ({ commit: { sha: targetHead } })],
    ['/rules/branches/' + encodeURIComponent(target) + '?per_page=100', () => [[rule]]],
    ['/rulesets/42', () => ({ id: 42, enforcement: 'active', current_user_can_bypass: 'never' })],
    ['/git/commits/' + candidate.head, () => ({ sha: candidate.head, tree: { sha: candidate.tree } })],
    ['/git/commits/' + updated, () => ({ parents: [candidate.head, advanced].map((sha) => ({ sha })) })],
    ['/git/commits/' + merged, () => ({ parents: [advanced, updated].map((sha) => ({ sha })) })],
    [
      '/git/refs',
      (args) => {
        assert.deepEqual(args, [
          '--method',
          'POST',
          '-f',
          'ref=refs/heads/' + scope.branch,
          '-f',
          'sha=' + candidate.head,
        ]);
        return {};
      },
    ],
    [
      '/pulls',
      (args) => {
        assert.equal(args[1], 'POST');
        assert.ok(args.includes('head=' + scope.branch) && args.includes('base=' + target));
        const pr = pull(verificationPR, scope.branch, candidate.head);
        prs.set(pr.number, pr);
        return pr;
      },
    ],
    ['/pulls/' + advance.number, () => prs.get(advance.number)],
    ['/pulls/' + verificationPR, () => prs.get(verificationPR)],
    ['/pulls/' + advance.number + '/merge', (args) => merge(advance.number, args)],
    ['/pulls/' + verificationPR + '/merge', (args) => merge(verificationPR, args)],
    [
      '/pulls/' + verificationPR + '/update-branch',
      (args) => {
        assert.deepEqual(args, ['--method', 'PUT', '-f', 'expected_head_sha=' + candidate.head]);
        prs.get(verificationPR).head.sha = updated;
        return { message: 'Updating branch' };
      },
    ],
    [
      'graphql',
      (args) => {
        const pr = prs.get(Number(args.find((arg) => arg.startsWith('number=')).slice(7)));
        return [
          {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: pr.head.sha,
                  baseRefName: target,
                  baseRefOid: targetHead,
                  baseRef: { target: { oid: targetHead } },
                  mergeStateStatus: 'CLEAN',
                  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check] } } } }] },
                },
              },
            },
          },
        ];
      },
    ],
  ]);
  provider.gh = async ([command, endpoint, ...args]) => {
    assert.equal(command, 'api');
    const path = endpoint.replace('repos/' + repository, '');
    const response = responses.get(path);
    assert.ok(response, 'Unreviewed GitHub endpoint ' + endpoint);
    if (args.includes('--method')) writes.push({ path, args });
    return JSON.stringify(response(args));
  };
  return provider;
}

function inquiryConnection(proposal, sandboxes) {
  return {
    async ready() {},
    async call(method) {
      assert.equal(method, 'skills/list');
      return { data: [] };
    },
    async start(_cwd, sandbox, retain, _issueId, _root, instructions, tools) {
      assert.match(instructions, /Investigate is read-only/);
      assert.equal(tools, undefined);
      sandboxes.push(sandbox);
      retain({ status: 'ready', threadId: 'live-verification-inquiry-' + sandboxes.length });
      return 'live-verification-inquiry-' + sandboxes.length;
    },
    async turn() {
      return (
        '#291 needs a scoped live check.\n\n```flow-result\n' +
        JSON.stringify({ liveVerification: proposal() }) +
        '\n```'
      );
    },
    close() {},
  };
}

async function runInquiry(harness, block, savedBlock) {
  const { page, selectBlock, clickAction, service, poll } = harness;
  await page.goto('/?issue=' + issueId);
  await selectBlock(block.id);
  const started = await clickAction(page.locator('#run-block'));
  return poll(
    () => savedBlock().attempts.at(-1),
    (attempt) => attempt?.id === started.attemptId && attempt.endedAt && !service.flows.active.has(issueId),
    'The inquiry did not retain its proposal.'
  );
}

async function review({ page, screenshot }, scope, candidate) {
  const review = page.locator('#issue-permission-review');
  await review.waitFor();
  await page.locator('#issue-blocker-open').waitFor();
  assert.equal(await page.locator('#issue-permission-title').textContent(), 'Permission required');
  await review.click();
  const dialog = page.locator('#permission-review-dialog');
  const rendered = await dialog.innerText();
  for (const value of [
    scope.reason,
    repository,
    scope.branch,
    target,
    scope.targetHead,
    candidate.head,
    candidate.tree,
    String(advance.number),
    advance.branch,
    advance.head,
    'Create the disposable source branch',
    'Open a pull request',
    'Attempt the stale merge',
  ]) {
    assert.ok(rendered.includes(value), 'Missing review detail ' + value);
  }
  await screenshot('live-verification-' + scope.branch.split('/').at(-1));
  return rendered;
}

async function rejectApproval(page, flow, block, attemptId, permissionToken) {
  const response = await page.request.post('/api/flow-action', {
    headers: { origin: new URL(page.url()).origin, 'x-factory-action': 'manual', 'content-type': 'application/json' },
    data: {
      action: 'decide-live-verification',
      issueId,
      revision: flow.revision,
      blockId: block.id,
      attemptId,
      permissionToken,
      decision: 'allow-once',
    },
  });
  assert.match((await response.json()).error, /scope changed/);
}

export async function liveVerificationBrowserChecks(harness) {
  const { page, project, service, output, root, poll, screenshot, selectBlock, clickAction } = harness;
  const { lifecycle } = readProjectSettings(project);
  if (!lifecycle.present) initializeProjectLifecycle(service, { digest: lifecycle.digest });
  installBrowserHumanInput(project, root);
  await ensureProjectStores(service);
  const candidate = { head: git(project, 'rev-parse', 'HEAD'), tree: git(project, 'rev-parse', 'HEAD^{tree}') };
  await importBrowserIssue(
    project,
    issueId,
    `---\nid: ${issueId}\ntitle: '${title}'\nstate: backlog\nreusable: true\nrequest_type: investigation\n---\n\n## Original request\n\nUse a disposable protected GitHub target to observe #291 Full Send after readiness. Keep #282 outstanding.\n`,
    'open',
    299
  );
  const flows = service.flows;
  const saved = () => flows.read(flows.selected(issueId));
  const flow = saved();
  flow.startingPoint = { commit: candidate.head, name: 'dev', ref: 'refs/heads/dev' };
  await flows.store.save(flow, flow.revision);
  const block = saved().blocks.find(({ kind }) => kind === 'investigate');
  const savedBlock = () => saved().blocks.find(({ id }) => id === block.id);
  const firstScope = scopeFor('factory-proof/291-declined', '1'.repeat(40));
  let scope = firstScope;
  const writes = [];
  const sandboxes = [];
  const previous = flows.executor;
  flows.executor = createFlowExecutor(service, {
    createConnection: () => inquiryConnection(() => scope, sandboxes),
    liveVerificationProvider: (config) => fixtureProvider(project, config, scope, candidate, writes),
  });
  try {
    const first = await runInquiry(harness, block, savedBlock);
    assert.equal(first.status, 'completed', first.summary);
    assert.equal(first.result.liveVerification.branch, scope.branch);
    const issueView = await flows.view(issueId);
    assert.equal(issueView.issue.issueNumber, 299);
    const [oldReview] = issueView.liveVerificationReviews;
    const declinedReview = await review(harness, scope, candidate);
    await clickAction(page.locator('#permission-review-decline'));
    await page.locator('#issue-permission-scope').getByText('Permission was declined.', { exact: false }).waitFor();
    await rejectApproval(page, saved(), block, first.id, oldReview.scope.token);
    assert.equal(writes.length, 0);

    scope = scopeFor('factory-proof/291-approved', firstScope.targetHead);
    const origin = await runInquiry(harness, block, savedBlock);
    assert.equal(origin.status, 'completed', origin.summary);
    const [currentReview] = (await flows.view(issueId)).liveVerificationReviews;
    assert.notEqual(currentReview.scope.token, oldReview.scope.token);
    await rejectApproval(page, saved(), block, origin.id, oldReview.scope.token);
    assert.equal(writes.length, 0);

    const approvedReview = await review(harness, scope, candidate);
    const accepted = await clickAction(page.locator('#permission-review-approve'));
    const verified = await poll(
      () => savedBlock().attempts.at(-1),
      (attempt) => attempt?.id === accepted.attemptId && attempt.endedAt && !flows.active.has(issueId),
      'The approved verification did not finish.'
    );
    assert.equal(verified.status, 'completed', verified.summary);
    assert.equal(verified.verificationOrigin.attemptId, origin.id);
    assert.deepEqual(
      writes.map(({ path }) => path),
      [
        '/git/refs',
        '/pulls',
        '/pulls/2901/merge',
        '/pulls/2902/merge',
        '/pulls/2902/update-branch',
        '/pulls/2902/merge',
      ]
    );
    await rejectApproval(page, saved(), block, origin.id, currentReview.scope.token);
    assert.equal(writes.length, 6);
    assert.deepEqual(sandboxes, ['read-only', 'read-only']);

    await page.reload();
    await selectBlock(block.id);
    const result = page.locator('[data-attempt-id="' + verified.id + '"]');
    await result.getByRole('link', { name: 'Open originating investigation' }).click();
    await page.locator('[data-attempt-id="' + origin.id + '"]').waitFor();
    await result.getByRole('button', { name: 'Live verification observations' }).waitFor();
    await screenshot('live-verification-result');
    const evidence = JSON.parse(readFileSync(verified.evidence[0].path, 'utf8'));
    assert.equal(evidence.origin.attemptId, origin.id);
    assert.ok(evidence.observations.some(({ status }) => status === 405));
    assert.deepEqual(evidence.observations.at(-1).parents, [advanced, updated]);
    writeFileSync(
      join(output, 'live-verification-proof.json'),
      JSON.stringify(
        {
          sourceCommit: git(root, 'rev-parse', 'HEAD'),
          fixture: '#299 issue UI and #291 request with a simulated GitHub transport. No GitHub network or writes.',
          issueId,
          candidate,
          sandboxes,
          declinedReview,
          writesAfterDecline: 0,
          preDeclineReviewRejected: true,
          staleApproval: { rejected: true, writes: 0 },
          replay: { rejected: true, additionalWrites: 0 },
          approvedReview,
          writes,
          evidence,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    flows.executor.close();
    flows.executor = previous;
  }
}
