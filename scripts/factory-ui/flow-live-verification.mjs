import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { redactValue } from './activity.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { deliveryTarget, latestCurrentAttempt, startingPoint } from './flow-block-data.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { assertChecks, waitStrategyReadiness } from './strategy-readiness.mjs';

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const disposableBranch = z
  .string()
  .max(200)
  .regex(/^factory-proof\/[\w-]+(?:\/[\w-]+)*$/);
const requestSchema = z
  .object({
    operation: z.literal('full-send-late-target'),
    reason: z.string().trim().min(1).max(2000),
    repository: z
      .string()
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/),
    branch: disposableBranch,
    target: disposableBranch,
    targetHead: oid,
    advance: z.object({ number: z.number().int().positive(), branch: disposableBranch, head: oid }).strict(),
  })
  .strict()
  .refine(({ branch, target, advance }) => new Set([branch, target, advance.branch]).size === 3);

export const liveVerificationInstructions =
  'Investigate is read-only. Report why an external check is blocked. For a Full Send late-target check with a known disposable setup, return a top-level flow-result liveVerification object with operation "full-send-late-target", reason, repository (owner/name), branch (new source), target (existing protected test target), targetHead (its current SHA), and advance: { number, branch, head } for the existing PR that will advance that target. Use distinct factory-proof/ branches and known values only. Factory binds the candidate to this run’s inspected commit and tree. The proposal grants no permission. Never run or request shell escalation for the writes. If setup is missing, report what is needed.';

export function proposedLiveVerification(manifest) {
  if (manifest?.liveVerification === undefined) return {};
  const request = requestSchema.safeParse(manifest.liveVerification);
  if (!request.success) return { verificationRequestError: 'The proposed live check needs an exact disposable scope.' };
  return { liveVerification: request.data };
}

function verificationConfig(root, flow, request, sharedBranch) {
  const config = JSON.parse(readFileSync(join(root, '.issues/issue-delivery-config.json'), 'utf8'));
  requireThat(
    config.provider === 'github' && config.repository === request.repository,
    'Use the configured GitHub repository for live verification.'
  );
  const reserved = [config.target, deliveryTarget(flow).branch, flow.workspace?.branch, sharedBranch];
  requireThat(
    ![request.branch, request.target, request.advance.branch].some((branch) => reserved.includes(branch)),
    'Use disposable branches outside delivery, issue work and the shared queue.'
  );
  return { ...config, target: request.target };
}

function verificationScope(service, flow, attempt) {
  const { head, tree, liveVerification, uncommitted } = attempt.result;
  const request = requestSchema.parse(liveVerification);
  verificationConfig(service.root, flow, request, service.sharedIssues?.branch);
  const candidate = { head: oid.parse(head), tree: oid.parse(tree) };
  const expected = startingPoint(flow)?.commit ?? head;
  requireThat(!uncommitted, 'Live verification requires a committed candidate.');
  requireThat(expected === head, 'The investigation candidate changed. Run Investigate again before approving.');
  requireThat(
    git(service.root, 'rev-parse', '--verify', head + '^{tree}') === tree,
    'The investigation candidate tree could not be verified.'
  );
  return { ...request, candidate };
}

function verificationReview(service, flow, block, attempt) {
  const scope = verificationScope(service, flow, attempt);
  return {
    blockId: block.id,
    attemptId: attempt.id,
    scope: {
      ...scope,
      token: digest(JSON.stringify([flow.issueId, block.id, attempt.id, attempt.verificationDeclinedAt, scope])),
    },
    declined: Boolean(attempt.verificationDeclinedAt),
  };
}

export function liveVerificationReviews(service, issue, flow) {
  if (issue.closed || issue.location === 'archive') return [];
  return flow.blocks
    .filter(({ kind }) => kind === 'investigate')
    .flatMap((block) => pendingReview(service, flow, block));
}

function pendingReview(service, flow, block) {
  const attempt = latestCurrentAttempt(block);
  if (!sourceIsCurrent(attempt)) return [];
  try {
    return requestedReview(service, flow, block, attempt);
  } catch (error) {
    return [{ blockId: block.id, attemptId: attempt.id, error: redactValue(error.message) }];
  }
}

function requestedReview(service, flow, block, attempt) {
  const { liveVerification, verificationRequestError } = attempt.result ?? {};
  if (verificationRequestError) throw Error(verificationRequestError);
  return liveVerification ? [verificationReview(service, flow, block, attempt)] : [];
}

function sameIdentity(actual, expected) {
  return actual.every((value, index) => value === expected[index]);
}

function reviewedRef(ref) {
  return [ref?.repo?.full_name, ref?.ref, ref?.sha];
}

function requireReviewedPR(pr, scope, branch, head) {
  requireThat(
    sameIdentity([pr.state, Boolean(pr.merged_at), pr.draft, Boolean(pr.auto_merge)], ['open', false, false, false]),
    'The verification PR is no longer open and ready for manual merge.'
  );
  const actual = [...reviewedRef(pr.base).slice(0, 2), ...reviewedRef(pr.head)];
  requireThat(
    sameIdentity(actual, [scope.repository, scope.target, scope.repository, branch, head]),
    'The verification PR changed. Inspect it before requesting fresh approval.'
  );
}

async function observeReadiness(provider, scope, pr, branch, head, target) {
  requireReviewedPR(pr, scope, branch, head);
  const ready = await provider.ready(pr, branch, head, { waitForChecks: true });
  requireThat(ready.target === target, 'The verification target changed. Request fresh approval.');
  assertChecks(ready.checks.filter(({ isRequired }) => isRequired));
  return ready;
}

function githubVerification(provider, scope, signal) {
  const endpoint = 'repos/' + scope.repository;
  const api = async (path, args = []) => {
    signal.throwIfAborted();
    return JSON.parse(await provider.gh(['api', endpoint + path, ...args]));
  };
  const targetHead = async () => (await api('/branches/' + encodeURIComponent(scope.target))).commit.sha;
  return {
    api,
    targetHead,
    ready(number, branch, head, target) {
      return waitStrategyReadiness(
        { strategyDelay: (milliseconds) => delay(milliseconds, undefined, { signal }) },
        {},
        async () => {
          signal.throwIfAborted();
          return observeReadiness(provider, scope, await provider.inspect(number), branch, head, target);
        }
      );
    },
    merge(number, branch, head, target) {
      return provider.merge(number, head, {
        requireFreshTarget: true,
        async beforeMerge() {
          requireReviewedPR(await provider.inspect(number), scope, branch, head);
          requireThat((await targetHead()) === target, 'The verification target changed before merge.');
        },
      });
    },
  };
}

async function requireRemoteCandidate(github, { repository, branch, target, advance, candidate }) {
  const repo = await github.api('');
  requireThat(
    repo.full_name === repository && repo.allow_merge_commit,
    'Use the configured repository with merge commits enabled.'
  );
  requireThat(
    ![branch, target, advance.branch].includes(repo.default_branch),
    'Choose disposable branches outside the GitHub default branch.'
  );
  const commit = await github.api('/git/commits/' + candidate.head);
  requireThat(
    sameIdentity([commit.sha, commit.tree.sha], [candidate.head, candidate.tree]),
    'Publish the inspected candidate to the configured repository before requesting this check.'
  );
}

async function startProbe(github, provider, scope, observed) {
  const { branch, target, targetHead, advance, candidate } = scope;
  await requireRemoteCandidate(github, scope);
  requireThat((await github.targetHead()) === targetHead, 'The verification target changed. Request fresh approval.');
  const protection = await provider.targetFreshnessProtection();
  await github.ready(advance.number, advance.branch, advance.head, targetHead);
  requireThat((await github.targetHead()) === targetHead, 'The verification target changed before branch creation.');
  await github.api('/git/refs', ['--method', 'POST', '-f', 'ref=refs/heads/' + branch, '-f', 'sha=' + candidate.head]);
  observed({ phase: 'Created verification branch', branch, head: candidate.head, protection });
  const pr = await github.api('/pulls', [
    '--method',
    'POST',
    '-f',
    'head=' + branch,
    '-f',
    'base=' + target,
    '-f',
    'title=Factory Full Send verification',
    '-f',
    'body=Disposable late-target branch protection verification.',
  ]);
  requireThat(Number.isSafeInteger(pr.number) && pr.number > 0, 'GitHub did not return the verification PR number.');
  requireReviewedPR(pr, scope, branch, candidate.head);
  return pr;
}

async function observeRejection(github, provider, scope, number, advanced) {
  try {
    await github.merge(number, scope.branch, scope.candidate.head, advanced);
  } catch (error) {
    if (error.githubStatus !== 405) throw error;
    const pr = await provider.inspect(number);
    requireReviewedPR(pr, scope, scope.branch, scope.candidate.head);
    requireThat(
      pr.mergeable_state === 'behind' && (await github.targetHead()) === advanced,
      'GitHub did not confirm that the stale PR is behind the reviewed advance.'
    );
    return { status: 405, diagnostic: redactValue(error.message), head: scope.candidate.head, target: advanced };
  }
  throw Error('GitHub accepted the stale merge. Inspect the disposable target before any further writes.');
}

async function refreshedHead(github, scope, number, advanced, signal) {
  const pr = await github.api('/pulls/' + number);
  requireReviewedPR(pr, scope, scope.branch, scope.candidate.head);
  requireThat((await github.targetHead()) === advanced, 'The verification target changed before the branch update.');
  const update = await github.api('/pulls/' + number + '/update-branch', [
    '--method',
    'PUT',
    '-f',
    'expected_head_sha=' + scope.candidate.head,
  ]);
  requireThat(update.message, 'GitHub did not acknowledge the verification branch update.');
  return waitForUpdatedHead(github, scope, number, advanced, signal);
}

async function waitForUpdatedHead(github, scope, number, advanced, signal) {
  const until = Date.now() + 120000;
  for (;;) {
    const pr = await github.api('/pulls/' + number);
    requireReviewedPR(pr, scope, scope.branch, pr.head.sha);
    if (pr.head.sha !== scope.candidate.head) {
      const head = await github.api('/git/commits/' + oid.parse(pr.head.sha));
      requireThat(
        JSON.stringify(head.parents.map(({ sha }) => sha)) === JSON.stringify([scope.candidate.head, advanced]),
        'The new head is outside the reviewed branch update.'
      );
      return pr.head.sha;
    }
    requireThat(Date.now() < until, 'Timed out waiting for the reviewed branch update.');
    await delay(2000, undefined, { signal });
  }
}

async function fullSendProbe(provider, scope, signal, observed) {
  const github = githubVerification(provider, scope, signal);
  const pr = await startProbe(github, provider, scope, observed);
  observed({ pr: pr.number, phase: 'Opened verification pull request' });
  const ready = await github.ready(pr.number, scope.branch, scope.candidate.head, scope.targetHead);
  observed({ phase: 'Candidate ready', ...ready });
  const advance = await github.merge(scope.advance.number, scope.advance.branch, scope.advance.head, scope.targetHead);
  observed({ phase: 'Protected target advanced', ...advance });
  const rejection = await observeRejection(github, provider, scope, pr.number, advance.revision);
  observed({ phase: 'GitHub rejected the stale merge', ...rejection });
  const head = await refreshedHead(github, scope, pr.number, advance.revision, signal);
  const refreshed = await github.ready(pr.number, scope.branch, head, advance.revision);
  observed({ phase: 'Updated candidate ready', ...refreshed });
  const merged = await github.merge(pr.number, scope.branch, head, advance.revision);
  const commit = await github.api('/git/commits/' + oid.parse(merged.revision));
  const parents = commit.parents.map(({ sha }) => sha);
  observed({ phase: 'GitHub confirmed merge', ...merged, parents });
  requireThat(
    JSON.stringify(parents) === JSON.stringify([advance.revision, head]),
    'GitHub merge parents did not match the reviewed delivery.'
  );
}

function sourceIsCurrent(attempt) {
  return ['completed', 'blocked'].includes(attempt?.status) && !attempt.invalidatedAt && !attempt.cancelledByEdit;
}

export async function executeLiveVerification(service, ctx, directory, providerFactory) {
  const { block, attempt, signal, flow } = ctx;
  const { attemptId, scope } = attempt.verificationOrigin;
  const source = block.attempts.find(({ id }) => id === attemptId);
  requireThat(sourceIsCurrent(source), 'The originating investigation changed.');
  const reviewed = verificationReview(service, flow, block, source);
  requireThat(reviewed.scope.token === scope.token, 'The reviewed operation changed. Request fresh approval.');
  const config = verificationConfig(service.root, flow, scope, service.sharedIssues?.branch);
  const provider = providerFactory ? providerFactory(config) : new StrategyProvider(service.root, config);
  requireThat(provider.credentials, 'Live verification requires configured GitHub App credentials.');
  return retainVerification(directory, attempt.verificationOrigin, async (observe) => {
    service.guard(service.root, { id: attempt.id, issues: [ctx.issue.id] }, 'verify', scope.candidate.head);
    await fullSendProbe(provider, scope, signal, observe);
  });
}

async function retainVerification(directory, origin, run) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'live-verification.json');
  const observations = [];
  let failure;
  try {
    await run((value) => {
      observations.push({ at: new Date().toISOString(), ...value });
      writeJson(path, redactValue({ origin, observations }));
    });
  } catch (error) {
    failure = redactValue(error.message);
  }
  writeJson(path, redactValue({ origin, observations, failure }));
  return {
    status: failure ? 'blocked' : 'completed',
    summary: failure
      ? 'Live verification stopped. ' + failure
      : 'Live verification confirmed the protected merge after refreshing the stale head.',
    result: { verification: { attemptId: origin.attemptId, observations: redactValue(observations) } },
    evidence: [{ path, sha256: digest(readFileSync(path)), label: 'Live verification observations' }],
  };
}
