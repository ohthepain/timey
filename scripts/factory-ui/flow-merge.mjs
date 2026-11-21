import { mergeGitHubProvider, inspectMergeOutcome } from './flow-merge-github.mjs';
import { verificationFailureKey } from './flow-repair-evidence.mjs';
import { retainGitHubFailure } from './flow-ci-evidence.mjs';
import { abortPendingMerge } from './flow-update-branch.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deliveryTarget, missingMergePR } from './flow-block-data.mjs';
import { digest, git, requireThat } from './common.mjs';
import {
  assertPublicationIdle,
  assertFlowRemote,
  ensureFlowVerification,
  flowDeliveryProvider,
  lookupFlowPR,
  verifiedFlowCandidate,
} from './flow-delivery.mjs';
import { blockerKey, permissionFailure, repairableBlocker } from './strategy-repair.mjs';
import { fetchIssueTarget, mergeIssueTarget } from './flow-update-branch.mjs';
import { queueReportPaths } from './shared-issue-config.mjs';

const headOf = (workspace) => git(workspace.checkout, 'rev-parse', 'HEAD');
const treeOf = (workspace) => git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');

function includesCommit(workspace, head, revision) {
  return git(workspace.checkout, 'merge-base', head, revision) === revision;
}

function cleanCheckout(workspace) {
  return !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all');
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

function repairableMergeFailure(error) {
  return (
    error.code !== 'MERGE_CHECK_TIMEOUT' &&
    (['target-conflict', 'ci-failure'].includes(error.code) || error.verificationFailure)
  );
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

async function repairCandidate(ctx, workspace, error, options, state) {
  if (ctx.signal.aborted || !repairableMergeFailure(error) || permissionFailure(error)) throw error;
  const before = headOf(workspace);
  const tree = treeOf(workspace);
  const attempt = reserveRepair(error, tree, state);
  const conflict = error.code === 'target-conflict';
  state.evidence.push(...(error.evidence ?? []));
  state.repairs += 1;
  ctx.onProgress('Repairing this Merge blocker (' + attempt + '/' + state.workflow.repairAttempts + ').\n', true);
  const repair = await options.repair(error, state.repairs);
  state.evidence.push(...(repair.evidence ?? []));
  requireThat(repair.status !== 'blocked', repair.summary);
  const after = headOf(workspace);
  requireThat(
    cleanCheckout(workspace) &&
      after !== before &&
      includesCommit(workspace, after, before) &&
      (conflict || treeOf(workspace) !== tree),
    'The repair did not produce a changed, committed issue candidate. Review the retained work before retrying.'
  );
}

async function mergeWhenReady(service, ctx, workspace, provider, pr, readiness, options, state) {
  const { head, target } = readiness;
  const confirmation = mergeConfirmation(ctx, provider, pr, readiness);
  const verification = state.checked.verification;
  verifiedFlowCandidate(ctx, workspace, { ...options, verification });
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
      result: { pr: pr.number, head, target, verification, checks: readiness.checks, mergeConfirmation: confirmation },
    };
  }
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
        verifiedFlowCandidate(ctx, workspace, { ...options, verification });
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
    result: { ...merged, pr: pr.number, head, target, verification, checks: readiness.checks, mergeOrigin },
    summary: 'GitHub confirms the protected merge.',
  };
}

async function verifyMergeCandidate(service, ctx, workspace, head, options, state) {
  const input = options.verificationInput(ctx, workspace.checkout, options.verificationBase);
  if (state.checked?.head !== head || state.checkedInput !== input) {
    state.checked = await ensureFlowVerification(
      service,
      ctx,
      workspace,
      join(state.folder, 'verify-' + head + '-' + input),
      options
    );
    state.evidence.push(...state.checked.evidence);
    state.checkedInput = input;
  }
}

async function retainFailedChecks(provider, error, head, checkout, onProgress) {
  if (error.code !== 'ci-failure') return;
  onProgress('Reading the failed GitHub check output before repair.\n', true);
  await retainGitHubFailure(provider, error, head, checkout);
}

async function readMergeReadiness(ctx, workspace, provider, pr, state) {
  try {
    ctx.onProgress('Checking GitHub PR readiness before local verification.\n', true);
    const readiness = await provider.ready(pr, workspace.branch, pr.head.sha, {
      waitForChecks: state.pushed === pr.head.sha,
    });
    return { readiness };
  } catch (readinessError) {
    if (!['STRATEGY_PENDING', 'target-outdated', 'target-conflict', 'ci-failure'].includes(readinessError.code))
      throw readinessError;
    return { readinessError };
  }
}

async function requireObservedChecks(ctx, workspace, provider, error, head) {
  if (!error) return;
  if (['target-outdated', 'target-conflict'].includes(error.code)) throw pending(error.message);
  await retainFailedChecks(provider, error, head, workspace.checkout, ctx.onProgress);
  throw error;
}

async function advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state) {
  const { readiness, readinessError } = await readMergeReadiness(ctx, workspace, provider, pr, state);
  const target = await fetchTarget(ctx, workspace, invoke);
  await synchronize(workspace, target, invoke);
  const head = headOf(workspace);
  const verificationOptions = { ...options, verificationBase: target };
  if (head === pr.head.sha) await requireObservedChecks(ctx, workspace, provider, readinessError, head);
  await verifyMergeCandidate(service, ctx, workspace, head, verificationOptions, state);
  if (pr.head.sha !== head) {
    if (state.pushed === head && state.previousHead === pr.head.sha)
      throw pending('Waiting for GitHub to observe the updated PR commit.');
    requireThat(
      includesCommit(workspace, head, pr.head.sha),
      'The PR branch changed independently. Reconcile it before merging.'
    );
    verifiedFlowCandidate(ctx, workspace, { ...verificationOptions, verification: state.checked.verification });
    const { remote } = deliveryTarget(ctx.flow);
    assertFlowRemote(workspace, remote, provider.config.repository);
    await invoke('git', ['push', remote, head + ':refs/heads/' + workspace.branch]);
    state.previousHead = pr.head.sha;
    state.pushed = head;
    state.deadline = Date.now() + state.workflow.checkTimeoutSeconds * 1000;
    throw pending('Pushed the verified commit. Waiting for GitHub checks.');
  }
  if (readiness.target !== target) throw pending('GitHub and the fetched target differ. Refreshing both revisions.');
  if ((await fetchTarget(ctx, workspace, invoke)) !== target) return undefined;
  return mergeWhenReady(service, ctx, workspace, provider, pr, readiness, verificationOptions, state);
}

async function prepareMergeCheckout(state, workspace, invoke) {
  if (state.started) return;
  await abortPendingMerge(workspace, invoke);
  state.started = true;
}

function retainedMergeVerification(ctx) {
  const previous = ctx.block.attempts?.filter((attempt) => attempt.id !== ctx.attempt.id).at(-1);
  if (previous?.invalidatedAt) return undefined;
  return previous?.result?.verification;
}

function mergeVerification(ctx, state) {
  return state.checked?.verification ?? retainedMergeVerification(ctx);
}

async function waitForMergeChecks(ctx, state, error, options) {
  state.deadline ??= Date.now() + state.workflow.checkTimeoutSeconds * 1000;
  requireThat(Date.now() < state.deadline, 'GitHub checks did not finish in time. ' + error.message);
  ctx.onProgress(error.message + '\n', true);
  await (options.mergeDelay ?? delay)(state.workflow.pollSeconds * 1000, undefined, { signal: ctx.signal });
}

function retainMergeFailure(error, ctx, state, pr) {
  error.deliveryVerification = mergeVerification(ctx, state);
  if (error.humanInput) error.humanInput = { ...error.humanInput, url: pr?.html_url };
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
    folder,
    workflow,
    prepareOnly: ctx.input?.prepareMerge === true,
    repairs: 0,
    blockers: new Map(),
    evidence: [],
  };
  const evidence = () => [
    ...state.evidence,
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
        const ready = await provider.ready(pr, workspace.branch, headOf(workspace));
        return {
          result: { ...ready.merge, pr: pr.number, alreadyMerged: true },
          evidence: evidence(),
          workspace: { ...workspace, pr: pr.number },
          summary: 'GitHub confirms the PR was already merged. Acceptance remains separate.',
        };
      }
      requireThat(pr.state === 'open' && !pr.draft, 'Open the PR and mark it ready for review on GitHub.');
      assertFlowRemote(workspace, deliveryTarget(ctx.flow).remote, provider.config.repository, 'fetch');
      await assertPublicationIdle(provider, pr, workspace.branch);
      service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'implement', workspace.base);
      await prepareMergeCheckout(state, workspace, invoke);
      try {
        const outcome = await advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state);
        if (outcome) return { ...outcome, evidence: evidence(), workspace: { ...workspace, pr: pr.number } };
      } catch (error) {
        if (error.code !== 'STRATEGY_PENDING') await repairCandidate(ctx, workspace, error, options, state);
        else await waitForMergeChecks(ctx, state, error, options);
      }
      pr = await lookupFlowPR(provider, workspace.branch, number);
      requireThat(pr, 'The existing PR is no longer available.');
    }
  } catch (error) {
    error.evidence = [...evidence(), ...(error.evidence ?? [])];
    retainMergeFailure(error, ctx, state, pr);
    throw error;
  }
}
