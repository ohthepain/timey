import { browserFailure, runCandidateBrowser } from './flow-browser-evidence.mjs';
import { mergeGitHubProvider, inspectMergeOutcome } from './flow-merge-github.mjs';
import {
  mergeRepairHistory,
  retainMergeRepairEvidence,
  verificationFailureKey,
  verificationFailureMessage,
} from './flow-repair-evidence.mjs';
import { githubCheckRuns, retainGitHubFailure } from './flow-ci-evidence.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deliveryTarget, missingMergePR } from './flow-block-data.mjs';
import { digest, git, requireThat, writeJson } from './common.mjs';
import {
  assertPublicationIdle,
  assertFlowRemote,
  deliveryWorkProof,
  flowDeliveryProvider,
  lookupFlowPR,
} from './flow-delivery.mjs';
import { blockerKey, permissionFailure, repairableBlocker } from './strategy-repair.mjs';
import { fetchIssueTarget, mergeIssueTarget } from './flow-update-branch.mjs';
import { queueReportPaths } from './shared-issue-config.mjs';
import { observeMergeWait, startMergeWait } from './flow-merge-wait.mjs';
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
    git(workspace.checkout, 'branch', '--show-current') === workspace.branch &&
      cleanCheckout(workspace) &&
      headOf(workspace) === head,
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
      includesCommit(workspace, candidate, state.comparisonTarget),
      'The repair did not retain the fetched target in the issue branch.'
    );
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

async function mergeWhenReady(service, ctx, workspace, provider, pr, readiness, state, refreshTarget) {
  const { head, target } = readiness;
  const confirmation = mergeConfirmation(ctx, provider, pr, readiness);
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
      result: { pr: pr.number, head, target, checks: readiness.checks, mergeConfirmation: confirmation },
    };
  }
  state.repairHistory.validateAttachments();
  service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id], worker_revision: head }, 'merge', target);
  ctx.signal.throwIfAborted();
  ctx.onProgress('Merging the GitHub PR.\n', true);
  const delivery = await requestVerifiedMerge(provider, workspace, pr, readiness, refreshTarget, ctx.signal);
  return {
    result: { ...delivery, pr: pr.number, head, target, checks: readiness.checks },
    summary: 'GitHub confirms the protected merge.',
  };
}

async function requestVerifiedMerge(provider, workspace, pr, { head, target }, refreshTarget, signal) {
  const observePR = () => lookupFlowPR(provider, workspace.branch, pr.number, { metadataOnly: true });
  try {
    const merged = await provider.merge(pr.number, head, observePR, {
      requireFreshTarget: true,
      beforeMerge: async () => {
        if ((await refreshTarget()) !== target)
          throw pending('The target advanced before merge. Preparing the PR again.');
        const actual = await lookupFlowPR(provider, workspace.branch, pr.number);
        requireThat(actual, 'The existing PR is no longer available.');
        const current = await provider.ready(actual, workspace.branch, head);
        if (current.target !== target || (await refreshTarget()) !== target)
          throw pending('The target advanced before merge. Preparing the PR again.');
        requireCleanCandidate(workspace, head);
        signal.throwIfAborted();
      },
    });
    return { ...merged, mergeOrigin: 'factory-confirmed' };
  } catch (error) {
    if (['STRATEGY_PENDING', 'target-protection'].includes(error.code) || permissionFailure(error)) throw error;
    return reconcileMergeRequest(provider, observePR, workspace.branch, { head, target }, refreshTarget, error);
  }
}

async function reconcileMergeRequest(provider, observePR, branch, { head, target }, refreshTarget, error) {
  const actual = await inspectMergeOutcome(observePR, error);
  if (actual?.merged_at) {
    const { merge } = await provider.ready(actual, branch, head);
    return { ...merge, mergeOrigin: 'observed-merged' };
  }
  if ((await refreshTarget()) !== target)
    throw pending('The target advanced during the merge request. Preparing the PR again.');
  throw error;
}

async function readMergeReadiness(ctx, workspace, provider, pr, head) {
  try {
    ctx.onProgress('Checking GitHub PR readiness.\n', true);
    const actual = await lookupFlowPR(provider, workspace.branch, pr.number);
    requireThat(actual, 'The existing PR is no longer available.');
    const readiness = await provider.ready(actual, workspace.branch, head, {
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
  if (error.code === 'ci-failure') {
    ctx.onProgress('Reading the failed GitHub check output before repair.\n', true);
    await retainGitHubFailure(provider, error, head, root);
  }
  throw observedMergeBlocker(error);
}

function observedMergeBlocker(error) {
  if (error.code === 'target-outdated') return pending(error.message);
  if (error.code === 'target-conflict')
    return Error(
      'GitHub reports a merge conflict, but the issue branch already contains the fetched target. Check the PR on GitHub and retry Merge when its merge status updates.'
    );
  return error;
}

async function pushMergeCandidate(ctx, workspace, provider, invoke, state, head) {
  if (state.pushed === head) return;
  const { remote } = deliveryTarget(ctx.flow);
  assertFlowRemote(workspace, remote, provider.config.repository);
  await invoke('git', ['push', remote, head + ':refs/heads/' + workspace.branch]);
  state.pushed = head;
}

async function prepareBrowserEvidence(ctx, workspace, head, options, state) {
  if (state.browser.has(head)) return;
  const candidate = { head, tree: treeOf(workspace) };
  const directory = join(state.folder, 'browser-' + head);
  mkdirSync(directory, { recursive: true });
  const result = await runCandidateBrowser(ctx, workspace, directory, candidate, options.execute);
  state.browser.set(head, result);
  if (!result) return;
  state.evidence.push(...[result.log, result.results, ...result.files].filter(Boolean));
  if (result.exit) throw failedBrowserCandidate(head, result);
}

function failedBrowserCandidate(head, result) {
  const { scenario, assertion } = browserFailure(result);
  const diagnostic = [scenario, assertion].filter(Boolean).join('. ');
  return repairableBlocker(
    'ci-failure',
    `Focused browser check failed on ${head.slice(0, 12)}. ${diagnostic}`,
    [result.log, result.results].filter(Boolean)
  );
}

function retainDeliveryReceipt(service, ctx, state, provider, workspace, result) {
  const candidate = commitIdentity(workspace, result.head);
  const browser = state.browser.get(candidate.commit);
  const workProof = deliveryWorkProof({ ...ctx, evidenceRoot: service.root }, candidate);
  const receipt = {
    candidate,
    checks: result.checks ?? [],
    jobs: githubCheckRuns(provider.config.repository, result.checks ?? []),
    workProof,
    ...(browser && { browser, browserProofReason: 'Focused scenarios rerun on this candidate commit and tree.' }),
  };
  const path = join(state.folder, 'delivery-receipt.json');
  writeJson(path, receipt);
  const file = {
    key: 'deliveryReceipt',
    label: 'Candidate delivery receipt',
    path,
    sha256: digest(readFileSync(path)),
  };
  state.evidence.push(file);
  return file;
}

async function updateMergeCandidate(ctx, workspace, invoke, state) {
  requireThat(
    git(workspace.checkout, 'branch', '--show-current') === workspace.branch,
    'The issue branch changed. Open the managed issue branch and retry.'
  );
  const target = await fetchTarget(ctx, workspace, invoke);
  state.comparisonTarget = target;
  await synchronize(workspace, target, invoke);
  const head = headOf(workspace);
  requireCleanCandidate(workspace, head);
  return (state.candidate = { head, target });
}

async function advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state) {
  const { head, target } = state.candidate;
  requireThat(
    includesCommit(workspace, head, pr.head.sha),
    'The PR branch changed independently. Reconcile it before merging.'
  );
  await prepareBrowserEvidence(ctx, workspace, head, options, state);
  requireCleanCandidate(workspace, head);
  await pushMergeCandidate(ctx, workspace, provider, invoke, state, head);
  if (pr.head.sha !== head) throw pending('Waiting for GitHub to observe the pushed PR commit.');
  const refreshTarget = () => fetchTarget(ctx, workspace, invoke);
  const { readiness, readinessError } = await readMergeReadiness(ctx, workspace, provider, pr, head);
  if ((await refreshTarget()) !== target) return undefined;
  await requireObservedChecks(service.root, ctx, provider, readinessError, head);
  if (readiness.target !== target) throw pending('GitHub and the fetched target differ. Refreshing both revisions.');
  return mergeWhenReady(service, ctx, workspace, provider, pr, readiness, state, refreshTarget);
}

async function waitForMergeChecks(ctx, state, error, head, options) {
  const next = observeMergeWait(mergeWait(state, head, options.mergeNow), error.ciProgress);
  requireThat(next.kind !== 'timeout', 'GitHub checks did not finish in time. ' + error.message);
  if (next.kind === 'refresh') {
    ctx.onProgress('Checking GitHub once more before the CI wait times out.\n', true);
    return;
  }
  ctx.onProgress(error.message + '\n', true);
  const interval = Math.min(state.workflow.pollSeconds * 1000, next.remaining);
  await (options.mergeDelay ?? delay)(interval, undefined, { signal: ctx.signal });
}

function mergeWait(state, head, now) {
  if (state.wait?.head !== head) state.wait = startMergeWait(head, state.workflow.checkTimeoutSeconds * 1000, now);
  return state.wait;
}

function retainMergeFailure(error, { html_url, number, head } = {}, repository, evidence) {
  error.evidence = [...evidence, ...(error.evidence ?? [])];
  if (error.humanInput)
    error.humanInput = { ...error.humanInput, url: html_url, repository, pr: number, head: head?.sha };
}

async function finishMerge(state, provider, workspace, outcome, observed = outcome.result) {
  if (state.repairHistory.hasRepairs) {
    state.repairHistory.complete(await deliveryIdentity(provider, workspace, observed));
  }
  return outcome;
}

async function reviewMerge(service, ctx, workspace, provider, pr, invoke, options, state, originalHead) {
  requireThat(pr, missingMergePR(workspace.branch));
  requireMergeTarget(ctx, pr);
  if (pr.merged_at) return observeMergedPR(state, provider, workspace, pr, originalHead);
  requireThat(pr.state === 'open' && !pr.draft, 'Open the PR and mark it ready for review on GitHub.');
  await assertPublicationIdle(provider, pr, workspace.branch);
  const outcome = await advanceMerge(service, ctx, workspace, provider, pr, invoke, options, state);
  if (outcome) return finishMerge(state, provider, workspace, outcome);
}

async function handleMergeBlocker(service, ctx, workspace, error, options, state) {
  if (error.code === 'STRATEGY_PENDING') await waitForMergeChecks(ctx, state, error, state.candidate.head, options);
  else await repairCandidate(service, ctx, workspace, error, options, state);
}

async function observeMergedPR(state, provider, workspace, pr, head) {
  const ready = await provider.ready(pr, workspace.branch, head);
  const result = { ...ready.merge, pr: pr.number, head: pr.head.sha, checks: ready.checks, alreadyMerged: true };
  const outcome = { result, summary: 'GitHub confirms the PR was already merged. Acceptance remains separate.' };
  return finishMerge(state, provider, workspace, outcome, { ...ready, ...result });
}

function requireMergeTarget(ctx, pr) {
  requireThat(
    pr.base.ref === deliveryTarget(ctx.flow).branch,
    'GitHub changed the PR base to ' + pr.base.ref + '. Accept it in Destination before merging.'
  );
}

function mergePRLookup(provider, workspace, destination) {
  const lookup = (number) => lookupFlowPR(provider, workspace.branch, number, { metadataOnly: true });
  return (number = destination?.pr ?? workspace.pr) => lookup(number);
}

function mergeEvidence(state, log) {
  return [
    ...state.evidence,
    ...state.repairHistory.evidence(),
    ...(existsSync(log) ? [{ key: 'log', path: log, label: 'Target fetch and merge output' }] : []),
  ];
}

function completeMergeResult(service, ctx, state, provider, workspace, pr, outcome, log) {
  outcome.result.deliveryReceipt = retainDeliveryReceipt(service, ctx, state, provider, workspace, outcome.result);
  return { ...outcome, evidence: mergeEvidence(state, log), workspace: { ...workspace, pr: pr.number } };
}

export async function mergeFlowPR(service, ctx, workspace, folder, options) {
  const workflow = ctx.definition?.mergeWorkflow;
  requireThat(workflow, 'The Merge block needs workflow settings in its Markdown definition.');
  requireThat(workspace.branch !== deliveryTarget(ctx.flow).branch, 'Merge must use the saved issue branch.');
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
    comparisonTarget: null,
    folder,
    browser: new Map(),
    repairs: 0,
    blockers: new Map(),
    evidence: [],
    repairHistory: mergeRepairHistory(folder, ctx.attempt.id, log),
  };
  const evidence = () => mergeEvidence(state, log);
  const completed = (pr, outcome) => completeMergeResult(service, ctx, state, provider, workspace, pr, outcome, log);

  let pr;
  try {
    const lookup = mergePRLookup(provider, workspace, ctx.flow.destination);
    const originalHead = headOf(workspace);
    assertFlowRemote(workspace, deliveryTarget(ctx.flow).remote, provider.config.repository, 'fetch');
    service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'implement', workspace.base);
    for (;;) {
      ctx.signal.throwIfAborted();
      try {
        await updateMergeCandidate(ctx, workspace, invoke, state);
        pr = await lookup(pr?.number);
        const outcome = await reviewMerge(service, ctx, workspace, provider, pr, invoke, options, state, originalHead);
        if (outcome) return completed(pr, outcome);
      } catch (error) {
        await handleMergeBlocker(service, ctx, workspace, error, options, state);
      }
    }
  } catch (error) {
    retainMergeFailure(error, pr, provider.config.repository, evidence());
    throw error;
  }
}
