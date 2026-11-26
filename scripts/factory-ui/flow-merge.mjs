import { mergeGitHubProvider, inspectMergeOutcome } from './flow-merge-github.mjs';
import {
  mergeRepairHistory,
  retainMergeRepairEvidence,
  verificationFailureKey,
  verificationFailureMessage,
} from './flow-repair-evidence.mjs';
import { githubCheckRuns, retainGitHubFailure } from './flow-ci-evidence.mjs';
import { abortPendingMerge } from './flow-update-branch.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deliveryTarget, missingMergePR } from './flow-block-data.mjs';
import { digest, git, requireThat } from './common.mjs';
import { assertPublicationIdle, assertFlowRemote, flowDeliveryProvider, lookupFlowPR } from './flow-delivery.mjs';
import { blockerKey, permissionFailure, repairableBlocker } from './strategy-repair.mjs';
import { fetchIssueTarget, mergeIssueTarget } from './flow-update-branch.mjs';
import { queueReportPaths } from './shared-issue-config.mjs';
import { observeMergeWait, startMergeWait } from './flow-merge-wait.mjs';
import { requireGroupProof, savedMergeGroupProof } from './flow-group-proof.mjs';
import { groupChildren } from './issue-group.mjs';

const headOf = (workspace) => git(workspace.checkout, 'rev-parse', 'HEAD');
const treeOf = (workspace) => git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');

function commitIdentity(workspace, commit) {
  const [revision, tree, ...parents] = git(workspace.checkout, 'show', '-s', '--format=%H %T %P', commit).split(' ');
  return { commit: revision, tree, parents };
}

async function deliveryIdentity(provider, workspace, result) {
  const { repository } = provider.config;
  const candidate = commitIdentity(workspace, result.head);
  const target = commitIdentity(workspace, result.target);
  const checks = githubCheckRuns(repository, result.checks ?? []);
  if (!result.revision) return { repository, pr: result.pr, candidate, target, checks };
  const merge = await mergedIdentity(provider, result.revision);
  return { repository, pr: result.pr, candidate, target, checks, merge };
}

async function mergedIdentity(provider, revision) {
  const merged = JSON.parse(await provider.gh(['api', `repos/${provider.config.repository}/git/commits/${revision}`]));
  requireThat(merged.sha === revision && merged.tree?.sha, 'GitHub did not resolve the exact merge revision.');
  return {
    commit: merged.sha,
    tree: merged.tree.sha,
    parents: merged.parents.map(({ sha }) => sha),
  };
}

function includesCommit(workspace, head, revision) {
  return git(workspace.checkout, 'merge-base', head, revision) === revision;
}

function cleanCheckout(workspace) {
  return !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all');
}

function requireCleanCandidate(workspace, head) {
  requireThat(
    cleanCheckout(workspace) && headOf(workspace) === head,
    'The issue checkout changed. Commit or preserve its changes before retrying Merge.'
  );
}

function pending(message) {
  return Object.assign(Error(message), { code: 'STRATEGY_PENDING' });
}

function mergeConfirmation(ctx, provider, pr, { head, target }) {
  const { repository } = provider.config;
  const branch = pr.base.ref;
  const token = digest(JSON.stringify([ctx.issue.id, ctx.block.id, repository, pr.number, branch, head, target]));
  return { token, repository, pr: pr.number, branch, head, target, url: pr.html_url };
}

function previousApproval(ctx) {
  const previous = ctx.block.attempts?.filter((attempt) => attempt.id !== ctx.attempt.id).at(-1);
  if (previous?.invalidatedAt || previous?.status !== 'blocked' || ctx.input?.confirmed !== true) return undefined;
  const approval = previous.result?.mergeConfirmation;
  if (approval?.token === ctx.input.mergeToken) return approval;
}

function fetchTarget(ctx, workspace, invoke) {
  return fetchIssueTarget(workspace.checkout, deliveryTarget(ctx.flow), invoke);
}

async function synchronize(workspace, target, invoke) {
  if (includesCommit(workspace, headOf(workspace), target)) return;
  if (git(workspace.checkout, 'ls-files', '-u')) {
    requireThat(
      git(workspace.checkout, 'rev-parse', '--verify', 'MERGE_HEAD') === target,
      'The checkout has a different merge in progress. Reconcile it before retrying.'
    );
    throw repairableBlocker('target-conflict', 'Resolve the target merge conflicts in the issue checkout.');
  }
  requireThat(cleanCheckout(workspace), 'Preserve checkout changes in a commit before merging the target branch.');
  await mergeIssueTarget(workspace.checkout, target, invoke, (_, error) => {
    throw repairableBlocker(
      'target-conflict',
      'Resolve the target merge conflicts in the issue checkout.',
      error.evidence
    );
  });
}

function reserveRepair(error, tree, state) {
  const key = blockerKey({ code: error.code, message: error.message, blockerKey: verificationFailureKey(error) });
  const blocker = state.blockers.get(key) || { attempts: 0, trees: new Set() };
  requireThat(
    blocker.attempts < state.workflow.repairAttempts,
    'Stopped after ' + blocker.attempts + ' repair attempts for the same blocker. ' + error.message
  );
  requireThat(
    !blocker.trees.has(tree),
    'Merge repair returned to the same failing candidate without progress. ' + error.message
  );
  blocker.attempts++;
  blocker.trees.add(tree);
  state.blockers.set(key, blocker);
  return blocker.attempts;
}

async function repairCandidate(service, ctx, workspace, error, options, state) {
  if (ctx.signal.aborted || !['target-conflict', 'ci-failure'].includes(error.code) || permissionFailure(error))
    throw error;
  error.message = verificationFailureMessage(error);
  const before = headOf(workspace);
  const tree = treeOf(workspace);
  const attempt = reserveRepair(error, tree, state);
  state.evidence.push(...(error.evidence ?? []));
  state.repairs += 1;
  ctx.onProgress('Repairing this Merge blocker (' + attempt + '/' + state.workflow.repairAttempts + ').\n', true);
  const record = state.repairHistory.start(
    state.repairs,
    { ...commitIdentity(workspace, before), comparisonTarget: state.comparisonTarget },
    error
  );
  await runRecordedRepair(service, ctx, workspace, error, { before, tree, record }, options, state);
}

async function runRecordedRepair(service, ctx, workspace, error, { before, tree, record }, options, state) {
  const outcome = { status: 'failed' };
  try {
    await attemptRepair(error, async () => {
      const failure = retainMergeRepairEvidence(
        service.root,
        workspace.checkout,
        ctx.attempt.id,
        error,
        state.repairs,
        record.folder
      );
      outcome.failureEvidence = failure.copies;
      outcome.failedChecks = failure.recordedChecks;
      const repair = await options.repair(error, state.repairs, {
        evidence: failure.evidence,
        failedChecks: failure.failedChecks,
        ...record,
      });
      outcome.evidence = repair.evidence;
      state.evidence.push(...(repair.evidence ?? []));
      requireThat(repair.status !== 'blocked', repair.summary);
    });
    const candidate = committedRepair(workspace, before);
    requireThat(
      error.code === 'target-conflict' || treeOf(workspace) !== tree,
      'The repair did not change the candidate tree. Review the retained work before retrying.'
    );
    Object.assign(outcome, { status: 'committed', candidate, repairedRevision: commitIdentity(workspace, candidate) });
  } catch (failure) {
    outcome.message = failure.message;
    outcome.evidence ??= failure.evidence;
    throw failure;
  } finally {
    record.finish(outcome);
  }
}

function committedRepair(workspace, before) {
  const after = headOf(workspace);
  requireThat(
    cleanCheckout(workspace) && after !== before && includesCommit(workspace, after, before),
    'The repair did not produce a changed, committed issue candidate. Review the retained work before retrying.'
  );
  return after;
}

async function attemptRepair(error, operation) {
  try {
    return await operation();
  } catch (failure) {
    if (!error.verificationFailure || failure.name === 'AbortError') throw failure;
    failure.message = error.message + ' Repair stopped: ' + failure.message;
    failure.verificationFailure = error.verificationFailure;
    failure.evidence = [error.evidence, failure.evidence].flat().filter(Boolean);
    throw failure;
  }
}

async function mergeGroupProof(ctx, workspace, root, head, options, state) {
  if (!groupChildren(ctx.issue).length) return;
  const tree = treeOf(workspace);
  const check = (file) => requireGroupProof(ctx.issue, ctx.flow, tree, ctx.block, root, undefined, file);
  const saved = state.groupProof?.head === head ? state.groupProof : savedMergeGroupProof([ctx.block], head, tree);
  try {
    check(saved?.file);
    return saved;
  } catch (error) {
    if (error.code !== 'GROUP_PROOF_REQUIRED' || !options.refreshGroupProof) throw error;
  }
  ctx.onProgress('Rechecking the attached sub-issues on the final PR candidate.\n', true);
  const refreshed = await options.refreshGroupProof({ head, tree });
  state.evidence.push(...(refreshed.evidence ?? []));
  ctx.signal.throwIfAborted();
  requireCleanCandidate(workspace, head);
  requireThat(refreshed.status !== 'blocked', refreshed.summary);
  const file = refreshed.artifacts?.files?.subIssueProof;
  check(file);
  state.groupProof = { head, tree, file };
  return state.groupProof;
}

async function mergeWhenReady(service, ctx, workspace, provider, pr, readiness, options, state) {
  const { head, target } = readiness;
  const confirmation = mergeConfirmation(ctx, provider, pr, readiness);
  const groupProof = await mergeGroupProof(ctx, workspace, service.root, head, options, state);
  requireThat(
    !service.sharedIssues || !git(workspace.checkout, 'diff', '--name-only', target, head, '--', ...queueReportPaths()),
    'Shared issue reports require a separate queue PR.'
  );
  if (
    state.prepareOnly ||
    (state.workflow.policy === 'human-first' && previousApproval(ctx)?.token !== confirmation.token)
  ) {
    return {
      status: 'blocked',
      summary: 'PR #' + pr.number + ' passed its checks. Approve merging it into ' + pr.base.ref + '.',
      result: { pr: pr.number, head, target, checks: readiness.checks, mergeConfirmation: confirmation, groupProof },
    };
  }
  state.repairHistory.validateAttachments();
  service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id], worker_revision: head }, 'merge', target);
  ctx.signal.throwIfAborted();
  let merged;
  let mergeOrigin = 'factory-confirmed';
  try {
    ctx.onProgress('Merging the GitHub PR.\n', true);
    merged = await provider.merge(pr.number, head, {
      beforeMerge: async () => {
        const actual = await lookupFlowPR(provider, workspace.branch, pr.number);
        requireThat(actual, 'The existing PR is no longer available.');
        const current = await provider.ready(actual, workspace.branch, head);
        if (current.target !== target) throw pending('The target advanced before merge. Preparing the PR again.');
        requireCleanCandidate(workspace, head);
        ctx.signal.throwIfAborted();
      },
    });
  } catch (error) {
    const actual = await inspectMergeOutcome(provider, pr.number, error);
    if (!actual.merged_at) {
      if (
        actual.base?.ref === pr.base.ref &&
        actual.base?.sha &&
        actual.base.sha !== target &&
        !permissionFailure(error)
      )
        throw pending('The target advanced during the merge request. Preparing the PR again.');
      throw error;
    }
    merged = (await provider.ready(actual, workspace.branch, head)).merge;
    mergeOrigin = 'observed-merged';
  }
  return {
    result: { ...merged, pr: pr.number, head, target, checks: readiness.checks, mergeOrigin, groupProof },
    summary: 'GitHub confirms the protected merge.',
  };
}

async function readMergeReadiness(ctx, workspace, provider, pr) {
  try {
    ctx.onProgress('Checking GitHub PR readiness.\n', true);
    const readiness = await provider.ready(pr, workspace.branch, pr.head.sha, {
      waitForChecks: true,
    });
    return { readiness };
  } catch (readinessError) {
    if (!['STRATEGY_PENDING', 'target-outdated', 'target-conflict', 'ci-failure'].includes(readinessError.code))
      throw readinessError;
    return { readinessError };
  }
}

async function requireObservedChecks(root, ctx, provider, error, head) {
  if (!error) return;
  if (['target-outdated', 'target-conflict'].includes(error.code)) throw pending(error.message);
  if (error.code === 'ci-failure') {
    ctx.onProgress('Reading the failed GitHub check output before repair.\n', true);
    await retainGitHubFailure(provider, error, head, root);
  }
  throw error;
}

async function advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state) {
  const { readiness, readinessError } = await readMergeReadiness(ctx, workspace, provider, pr);
  if (readinessError?.code === 'STRATEGY_PENDING' && headOf(workspace) === pr.head.sha) throw readinessError;
  const target = await fetchTarget(ctx, workspace, invoke);
  state.comparisonTarget = target;
  await synchronize(workspace, target, invoke);
  const head = headOf(workspace);
  requireCleanCandidate(workspace, head);
  if (head === pr.head.sha) await requireObservedChecks(service.root, ctx, provider, readinessError, head);
  if (pr.head.sha !== head) {
    if (state.pushed === head && state.previousHead === pr.head.sha)
      throw pending('Waiting for GitHub to observe the updated PR commit.');
    requireThat(
      includesCommit(workspace, head, pr.head.sha),
      'The PR branch changed independently. Reconcile it before merging.'
    );
    const { remote } = deliveryTarget(ctx.flow);
    assertFlowRemote(workspace, remote, provider.config.repository);
    await invoke('git', ['push', remote, head + ':refs/heads/' + workspace.branch]);
    state.previousHead = pr.head.sha;
    state.pushed = head;
    state.wait = startMergeWait(head, state.workflow.checkTimeoutSeconds * 1000, options.mergeNow);
    throw pending('Pushed the updated issue commit. Waiting for GitHub checks.');
  }
  if (readiness.target !== target) throw pending('GitHub and the fetched target differ. Refreshing both revisions.');
  if ((await fetchTarget(ctx, workspace, invoke)) !== target) return undefined;
  return mergeWhenReady(service, ctx, workspace, provider, pr, readiness, options, state);
}

async function prepareMergeCheckout(state, workspace, invoke) {
  if (state.started) return;
  await abortPendingMerge(workspace, invoke);
  state.started = true;
}

async function waitForMergeChecks(ctx, state, error, head, options) {
  state.wait ??= startMergeWait(head, state.workflow.checkTimeoutSeconds * 1000, options.mergeNow);
  const next = observeMergeWait(state.wait, error.ciProgress);
  requireThat(next.kind !== 'timeout', 'GitHub checks did not finish in time. ' + error.message);
  if (next.kind === 'refresh') {
    ctx.onProgress('Checking GitHub once more before the CI wait times out.\n', true);
    return;
  }
  ctx.onProgress(error.message + '\n', true);
  const interval = Math.min(state.workflow.pollSeconds * 1000, next.remaining);
  await (options.mergeDelay ?? delay)(interval, undefined, { signal: ctx.signal });
}

function retainMergeFailure(error, pr, evidence) {
  error.evidence = [...evidence, ...(error.evidence ?? [])];
  if (error.humanInput) error.humanInput = { ...error.humanInput, url: pr?.html_url };
}

async function finishMerge(state, provider, workspace, outcome, observed = outcome.result) {
  if (state.repairHistory.hasRepairs) {
    state.repairHistory.complete(await deliveryIdentity(provider, workspace, observed));
  }
  return outcome;
}

async function observeMergedPR(state, provider, workspace, pr) {
  const ready = await provider.ready(pr, workspace.branch, headOf(workspace));
  const result = { ...ready.merge, pr: pr.number, alreadyMerged: true };
  const outcome = { result, summary: 'GitHub confirms the PR was already merged. Acceptance remains separate.' };
  return finishMerge(state, provider, workspace, outcome, { ...ready, ...result });
}

export async function mergeFlowPR(service, ctx, workspace, folder, options) {
  const workflow = ctx.definition?.mergeWorkflow;
  requireThat(workflow, 'The Merge block needs workflow settings in its Markdown definition.');
  const provider = mergeGitHubProvider(flowDeliveryProvider(service, ctx, workspace, options), ctx, options);
  const log = join(folder, 'merge.log');
  const invoke = (command, args) =>
    options.execute({
      command,
      args,
      cwd: workspace.checkout,
      log,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
  const state = {
    workflow,
    prepareOnly: ctx.input?.prepareMerge === true,
    repairs: 0,
    blockers: new Map(),
    evidence: [],
    repairHistory: mergeRepairHistory(folder, ctx.attempt.id, log),
  };
  const evidence = () => [
    ...state.evidence,
    ...state.repairHistory.evidence(),
    ...(existsSync(log) ? [{ key: 'log', path: log, label: 'Target fetch and merge output' }] : []),
  ];
  let pr;
  try {
    pr = await lookupFlowPR(provider, workspace.branch, ctx.flow.destination?.pr);
    requireThat(pr, missingMergePR(workspace.branch));
    const number = pr.number;
    for (;;) {
      ctx.signal.throwIfAborted();
      requireThat(
        pr.base.ref === deliveryTarget(ctx.flow).branch,
        'GitHub changed the PR base to ' + pr.base.ref + '. Accept it in Destination before merging.'
      );
      if (pr.merged_at) {
        const outcome = await observeMergedPR(state, provider, workspace, pr);
        return {
          ...outcome,
          evidence: evidence(),
          workspace: { ...workspace, pr: pr.number },
        };
      }
      requireThat(pr.state === 'open' && !pr.draft, 'Open the PR and mark it ready for review on GitHub.');
      assertFlowRemote(workspace, deliveryTarget(ctx.flow).remote, provider.config.repository, 'fetch');
      await assertPublicationIdle(provider, pr, workspace.branch);
      service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'implement', workspace.base);
      await prepareMergeCheckout(state, workspace, invoke);
      try {
        const outcome = await advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state);
        if (outcome) {
          await finishMerge(state, provider, workspace, outcome);
          return { ...outcome, evidence: evidence(), workspace: { ...workspace, pr: pr.number } };
        }
      } catch (error) {
        if (error.code !== 'STRATEGY_PENDING') await repairCandidate(service, ctx, workspace, error, options, state);
        else await waitForMergeChecks(ctx, state, error, pr.head.sha, options);
      }
      pr = await lookupFlowPR(provider, workspace.branch, number);
      requireThat(pr, 'The existing PR is no longer available.');
    }
  } catch (error) {
    retainMergeFailure(error, pr, evidence());
    throw error;
  }
}
