import { requireThat } from './common.mjs';
import { repairableBlocker, strategyDelay } from './strategy-repair.mjs';
import { requiredPRReview } from './flow-human-input.mjs';

const readinessQuery = `
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        baseRefName
        baseRefOid
        baseRef { target { oid } }
        mergeStateStatus
        reviewDecision
        autoMergeRequest { enabledAt }
        mergeQueueEntry { id }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100, after: $endCursor) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    __typename
                    ... on CheckRun {
                      isRequired(pullRequestNumber: $number)
                      name status conclusion detailsUrl startedAt
                      checkSuite {
                        app { slug }
                        workflowRun { workflow { name } }
                      }
                    }
                    ... on StatusContext {
                      isRequired(pullRequestNumber: $number)
                      context state targetUrl createdAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const mergeStateErrors = new Map([
  [
    'BEHIND',
    () =>
      repairableBlocker(
        'target-outdated',
        'GitHub requires the PR to be up to date. Fetch and merge the latest target branch.'
      ),
  ],
  [
    'DIRTY',
    () => repairableBlocker('target-conflict', 'The PR conflicts with the target. Resolve the merge conflicts.'),
  ],
  ['UNKNOWN', () => pendingReadiness('GitHub is still calculating PR merge readiness.')],
]);

function repositoryMatches(pr, repository) {
  return [pr.base?.repo?.full_name, pr.head?.repo?.full_name].every((name) => name === repository);
}

function assertIdentity(pr, config, branch, head) {
  requireThat(repositoryMatches(pr, config.repository), 'The PR belongs to a different repository.');
  requireThat(pr.base.ref === config.target, 'The PR target changed. No handoff or merge was recorded.');
  requireThat(
    pr.head.ref === branch && pr.head.sha === head,
    'The PR branch, target or candidate changed. No handoff or merge was recorded.'
  );
}

function assertMergeability(pr) {
  if (pr.merged_at) return;
  if (pr.mergeable === false)
    throw repairableBlocker(
      'target-conflict',
      'The issue PR conflicts with the target. Fetch and merge the target, resolving conflicts.'
    );
  if (pr.mergeable === null)
    throw Object.assign(Error('GitHub is still calculating PR mergeability.'), { code: 'STRATEGY_PENDING' });
}

function assertState(pr) {
  requireThat(pr.state === 'open' || pr.merged_at, 'The issue PR was closed without merging.');
  if (pr.draft)
    throw repairableBlocker('pr-draft', 'The issue PR must be non-draft. Complete the work and mark it ready.');
  assertMergeability(pr);
  requireThat(!pr.auto_merge, 'Disable auto-merge before Full Stop handoff.');
}

async function readReadinessPages(provider, number) {
  const [owner, name] = provider.config.repository.split('/');
  return JSON.parse(
    await provider.gh([
      'api',
      'graphql',
      '-f',
      'query=' + readinessQuery,
      '-f',
      'owner=' + owner,
      '-f',
      'name=' + name,
      '-F',
      'number=' + number,
      '--paginate',
      '--slurp',
    ])
  );
}

function checkedObservation(observation, head, target) {
  requireThat(observation?.baseRefOid, 'The GitHub PR readiness observation is missing.');
  requireThat(
    observation.headRefOid === head && observation.baseRefName === target,
    'The PR head or target changed while checking readiness. Refresh before merging.'
  );
  requireThat(!observation.autoMergeRequest, 'Remove this PR from auto-merge before handoff.');
  requireThat(!observation.mergeQueueEntry, 'Remove this PR from the merge queue before handoff.');
  return observation;
}

function assertBlockedPR(view, checks, waitForChecks) {
  if (view.reviewDecision === 'CHANGES_REQUESTED')
    throw repairableBlocker(
      'review-findings',
      'Address the actual requested review changes on this PR, preserving any human decision that cannot be resolved technically.'
    );
  if (view.reviewDecision === 'REVIEW_REQUIRED') throw requiredPRReview();
  const required = checks.filter((check) => check.isRequired);
  assertPassingChecks(required);
  if (waitForChecks && !required.length) throw pendingReadiness('Waiting for required GitHub checks to appear.');
  throw Error('GitHub reports that this PR is blocked. Open the PR to see the outstanding merge requirements.');
}

function checkIdentity(check) {
  const source = check.checkSuite ? checkSuiteSource(check.checkSuite) : legacyCheckSource(check);
  return [check.__typename, check.name ?? check.context, source].join(':');
}

function checkSuiteSource({ workflowRun, app }) {
  return [workflowRun?.workflow?.name, app?.slug].join(':');
}

function legacyCheckSource({ workflowName, app }) {
  return workflowName ?? app?.slug;
}

function checkTime(check) {
  return Date.parse(check.startedAt ?? check.createdAt ?? '1970-01-01');
}

function isNewer(check, previous) {
  if (!previous) return true;
  return checkTime(check) >= checkTime(previous);
}

export function latestChecks(checks) {
  const latest = new Map();
  for (const check of checks) {
    const key = checkIdentity(check);
    if (isNewer(check, latest.get(key))) latest.set(key, check);
  }
  return [...latest.values()];
}

function pendingCheck(check) {
  return check.__typename === 'StatusContext'
    ? ['PENDING', 'EXPECTED'].includes(check.state)
    : check.status !== 'COMPLETED';
}

function failedCheck(check) {
  if (pendingCheck(check)) return false;
  return check.__typename === 'StatusContext'
    ? check.state !== 'SUCCESS'
    : !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion);
}

function describeCheck(check) {
  const name = check.name ?? check.context;
  return name + ': ' + [check.detailsUrl, check.targetUrl, check.conclusion, check.state].find(Boolean);
}

export function assertChecks(checks) {
  if (!checks.length) throw pendingReadiness('Required PR checks have not appeared yet.');
  assertPassingChecks(checks);
}

async function checkHandoffReview(pr, view, canBypassReview) {
  if (view.reviewDecision === 'CHANGES_REQUESTED')
    throw repairableBlocker('review-findings', 'Address the requested review changes before handoff.');
  if (pr.merged_at || view.reviewDecision !== 'REVIEW_REQUIRED') return false;
  requireThat(await canBypassReview(), 'The PR is waiting for required human review.');
  return true;
}

async function assertHandoffReadiness(pr, view, checks, canBypassReview) {
  const reviewBypass = await checkHandoffReview(pr, view, canBypassReview);
  assertChecks(checks);
  const allowed = reviewBypass ? ['CLEAN', 'BLOCKED'] : ['CLEAN'];
  if (pr.merged_at || allowed.includes(view.mergeStateStatus)) return;
  throw repairableBlocker(
    'target-outdated',
    'GitHub reports unfinished checks, conflicts or an out-of-date branch. Fetch and merge the latest target branch.'
  );
}

function assertPassingChecks(checks) {
  const failed = checks.filter(failedCheck);
  if (failed.length)
    throw repairableBlocker(
      'ci-failure',
      'PR checks are pending or failed. Failed checks: ' + failed.map(describeCheck).join(', ')
    );
  const pending = checks.filter(pendingCheck);
  if (pending.length)
    throw pendingReadiness('PR checks are pending: ' + pending.map((check) => check.name ?? check.context).join(', '));
}

function assertRequiredChecks(checks) {
  assertPassingChecks(checks.filter((check) => check.isRequired));
}

function pendingReadiness(message) {
  return Object.assign(Error(message), { code: 'STRATEGY_PENDING' });
}

function assertMergeState(view, checks, waitForChecks) {
  const state = view.mergeStateStatus;
  if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(state)) return assertRequiredChecks(checks);
  if (state === 'BLOCKED') assertBlockedPR(view, checks, waitForChecks);
  const blocker = mergeStateErrors.get(state);
  throw blocker ? blocker() : Error('GitHub has not reported this PR ready to merge.');
}

function readinessResult(pr, head, target, checks) {
  const result = { number: pr.number, url: pr.html_url, head, target, checks };
  if (pr.merged_at) {
    requireThat(pr.merge_commit_sha, 'The merged PR has no confirmed merge revision.');
    Object.assign(result, { merged: true, merge: { url: pr.html_url, revision: pr.merge_commit_sha } });
  }
  return result;
}

export async function inspectReadiness(provider, pr, branch, head, canBypassHandoffReview, waitForChecks = false) {
  assertIdentity(pr, provider.config, branch, head);
  assertState(pr);
  const { live, checks } = await observeReadiness(provider, pr.number, head);
  if (canBypassHandoffReview) await assertHandoffReadiness(pr, live, checks, canBypassHandoffReview);
  else if (!pr.merged_at) assertMergeState(live, checks, waitForChecks);
  return readinessResult(pr, head, live.baseRefOid, checks);
}

export async function inspectRequiredPRChecks(provider, number, head) {
  const { live, checks } = await observeReadiness(provider, number, head);
  assertRequiredChecks(checks);
  const targetRevision = live.baseRef?.target?.oid;
  requireThat(targetRevision, 'GitHub did not resolve the current target branch for the merged PR.');
  return { targetRevision, checks };
}

async function observeReadiness(provider, number, head) {
  const pages = await readReadinessPages(provider, number);
  const observations = pages.map(({ data }) =>
    checkedObservation(data?.repository?.pullRequest, head, provider.config.target)
  );
  const live = observations.at(-1);
  requireThat(live, 'The GitHub PR readiness observation is missing.');
  return { live, checks: latestChecks(observations.flatMap(observedChecks)) };
}

function observedChecks(observation) {
  return observation.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
}

function pendingObservation(error, deadline) {
  return error.code === 'STRATEGY_PENDING' && Date.now() < deadline;
}

export async function waitStrategyReadiness(service, record, observe) {
  const deadline = readinessDeadline(service);
  for (;;) {
    try {
      return await observe();
    } catch (error) {
      if (!pendingObservation(error, deadline)) throw error;
      await strategyDelay(service, record, 5000);
    }
  }
}

function readinessDeadline(service) {
  return Date.now() + (service.strategyReadinessTimeout ?? 15 * 60 * 1000);
}
