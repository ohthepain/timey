import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observePRReview, flowHumanInput } from './factory-ui/flow-human-input.mjs';
import { issueBadges, issueBadgeIndex } from './factory-ui/issue-badges.mjs';

test('a fresh approval of the waiting PR clears its derived badge without resuming paused work', () => {
  const root = '/review-fixture';
  const repository = 'fixture/review';
  const issue = { id: 'target' };
  const flow = {
    destination: { pr: 42, branch: 'dev' },
    blocks: [
      {
        id: 'merge',
        kind: 'merge',
        attempts: [
          {
            status: 'blocked',
            endedAt: new Date().toISOString(),
            result: { humanInput: { kind: 'pr-review', repository, pr: 42, head: 'candidate' } },
          },
        ],
      },
    ],
  };
  const badge = () => issueBadges(issue, issueBadgeIndex([], []), { root, flow }).includes('needs-git-approval');
  assert.equal(badge(), true, 'No observation');
  observePRReview(root, repository, 43, 'APPROVED', 'candidate');
  assert.equal(badge(), true, 'Different PR');
  observePRReview(root, 'fixture/other', 42, 'APPROVED', 'candidate');
  assert.equal(badge(), true, 'Different repository');
  observePRReview(root, repository, 42, 'APPROVED', 'previous-head');
  assert.equal(badge(), true, 'Different head');
  observePRReview(root, repository, 42, 'REVIEW_REQUIRED', 'candidate');
  assert.equal(badge(), true, 'Still pending');
  observePRReview(root, repository, 42, 'APPROVED', 'candidate');
  assert.equal(badge(), false, 'Matching approval');
  assert.equal(flowHumanInput(flow).kind, 'pr-review', 'Paused route retains explicit Continue');
});

test('existing readiness response confirms approval while the protected checks still gate running work', async () => {
  const { inspectReadiness } = await import('./factory-ui/strategy-readiness.mjs');
  const root = '/review-readiness-fixture';
  const repo = { full_name: 'fixture/review' };
  const branch = 'test-branch';
  const head = 'test-head';
  const pr = {
    number: 31,
    state: 'open',
    mergeable: true,
    base: { ref: 'dev', repo },
    head: { ref: branch, sha: head, repo },
  };
  const issue = { id: 'waiting' };
  const flow = {
    destination: { pr: pr.number },
    blocks: [
      {
        id: 'merge',
        kind: 'merge',
        attempts: [
          {
            status: 'blocked',
            endedAt: new Date().toISOString(),
            result: { humanInput: { kind: 'pr-review', repository: repo.full_name, pr: pr.number, head } },
          },
        ],
      },
    ],
  };
  const badges = () => issueBadges(issue, issueBadgeIndex([], []), { root, flow });
  const required = { __typename: 'CheckRun', name: 'verify', status: 'IN_PROGRESS', isRequired: true };
  const live = {
    headRefOid: head,
    baseRefName: 'dev',
    baseRefOid: 'target',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [required] } } } }] },
  };
  let requests = 0;
  const provider = {
    reviewRoot: root,
    config: { repository: repo.full_name, target: 'dev' },
    async gh() {
      requests++;
      return JSON.stringify([{ data: { repository: { pullRequest: live } } }]);
    },
  };
  const read = () => inspectReadiness(provider, pr, branch, head, undefined, true);
  await assert.rejects(read(), /waiting for a required review/);
  assert.ok(badges().includes('needs-git-approval'));
  assert.equal(requests, 1);
  live.reviewDecision = 'APPROVED';
  await assert.rejects(read(), /checks are pending/);
  assert.ok(!badges().includes('needs-git-approval'));
  assert.equal(requests, 2);
  required.status = 'COMPLETED';
  required.conclusion = 'SUCCESS';
  live.mergeStateStatus = 'CLEAN';
  const ready = await read();
  assert.equal(ready.head, head);
  assert.equal(ready.target, 'target');
  assert.equal(requests, 3);
});
