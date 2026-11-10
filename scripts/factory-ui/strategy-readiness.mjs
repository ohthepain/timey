import { requireThat } from './common.mjs';
import { repairableBlocker, strategyDelay } from './strategy-repair.mjs';

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

async function assertNoEnrollment(provider, pr) {
  const [owner, name] = provider.config.repository.split('/');
  const enrollment = JSON.parse(
    await provider.gh([
      'api',
      'graphql',
      '-f',
      'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}',
      '-f',
      'owner=' + owner,
      '-f',
      'name=' + name,
      '-F',
      'number=' + pr.number,
    ])
  );
  const live = enrollment.data.repository.pullRequest;
  requireThat(live, 'The PR enrollment observation is missing.');
  requireThat(!live.autoMergeRequest, 'Remove this PR from auto-merge before handoff.');
  requireThat(!live.mergeQueueEntry, 'Remove this PR from auto-merge and the merge queue before handoff.');
}

async function checkReview(pr, view, canBypass) {
  if (view.reviewDecision === 'CHANGES_REQUESTED')
    throw repairableBlocker(
      'review-findings',
      'Address the actual requested review changes on this PR, preserving any human decision that cannot be resolved technically.'
    );
  if (pr.merged_at) return false;
  if (view.reviewDecision !== 'REVIEW_REQUIRED') return false;
  requireThat(await canBypass(), 'The PR is waiting for required human review.');
  return true;
}

function checkIdentity(check) {
  return [check.__typename, check.name ?? check.context, check.workflowName ?? check.app?.slug].join(':');
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
  if (!checks.length)
    throw Object.assign(Error('Required PR checks have not appeared yet.'), { code: 'STRATEGY_PENDING' });
  const failed = checks.filter(failedCheck);
  if (failed.length)
    throw repairableBlocker(
      'ci-failure',
      'PR checks are pending or failed. Failed checks: ' + failed.map(describeCheck).join(', ')
    );
  const pending = checks.filter(pendingCheck);
  if (pending.length)
    throw Object.assign(
      Error('PR checks are pending: ' + pending.map((check) => check.name ?? check.context).join(', ')),
      {
        code: 'STRATEGY_PENDING',
      }
    );
}

function assertMergeState(pr, view, reviewBypass) {
  if (pr.merged_at) return;
  const allowed = new Set(['CLEAN']);
  if (reviewBypass) allowed.add('BLOCKED');
  if (!allowed.has(view.mergeStateStatus))
    throw repairableBlocker(
      'target-outdated',
      'GitHub reports unfinished checks, conflicts or an out-of-date branch. Fetch and merge the latest target branch.'
    );
}

function readinessResult(pr, head, checks) {
  const result = { number: pr.number, url: pr.html_url, head, target: pr.base.sha, checks };
  if (pr.merged_at) {
    requireThat(pr.merge_commit_sha, 'The merged PR has no confirmed merge revision.');
    Object.assign(result, { merged: true, merge: { url: pr.html_url, revision: pr.merge_commit_sha } });
  }
  return result;
}

export async function inspectReadiness(provider, pr, branch, head, canBypass) {
  assertIdentity(pr, provider.config, branch, head);
  assertState(pr);
  await assertNoEnrollment(provider, pr);
  const view = JSON.parse(
    await provider.gh([
      'pr',
      'view',
      String(pr.number),
      '--repo',
      provider.config.repository,
      '--json',
      'reviewDecision,statusCheckRollup,mergeStateStatus',
    ])
  );
  const reviewBypass = await checkReview(pr, view, canBypass);
  const checks = latestChecks(view.statusCheckRollup || []);
  assertChecks(checks);
  assertMergeState(pr, view, reviewBypass);
  return readinessResult(pr, head, checks);
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
