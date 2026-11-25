import { activeGroupRequest } from './flow-group-scope.mjs';
import { issueTypes } from './flow-definitions.mjs';
import { mergedDelivery } from './merged-issue.mjs';
import {
  deliveryTarget,
  latestCurrentAttempt,
  requestData,
  startingPoint,
  upstreamBlocks,
} from './flow-block-data.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanEnvironment, digest, git, requireThat, writeJson } from './common.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { queueReportPaths } from './shared-issue-config.mjs';
import { recheckedGroupProof, requireGroupProof } from './flow-group-proof.mjs';
import { evidencePath } from './stores/evidence.mjs';
import { hydrateProjectEvidence } from './stores/runtime.mjs';
import { groupChildren } from './issue-group.mjs';
import { fetchIssueTarget } from './flow-update-branch.mjs';

const execute = promisify(execFile);

export function flowDeliveryProvider(service, ctx, workspace, options = {}) {
  requireThat(
    !service.sharedIssues?.branch || service.sharedIssues.branch !== deliveryTarget(ctx.flow).branch,
    'Choose a code destination outside the shared issue queue.'
  );
  const path = join(service.root, '.issues/issue-delivery-config.json');
  requireThat(
    existsSync(path),
    'Configure .issues/issue-delivery-config.json before publishing or delivering this issue PR.'
  );
  const config = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(
    config.provider === 'github' &&
      /^[\w.-]+\/[\w.-]+$/.test(config.repository) &&
      config.remote === deliveryTarget(ctx.flow).remote,
    'The saved flow and protected delivery repository or remote differ. Reconcile their configuration first.'
  );
  return (
    options.provider ||
    new StrategyProvider(workspace.checkout, { ...config, target: deliveryTarget(ctx.flow).branch }, service.root)
  );
}

export async function lookupFlowPR(provider, branch, number) {
  if (!branch && !Number.isSafeInteger(number)) return null;
  const pr = Number.isSafeInteger(number) ? await provider.inspect(number) : await provider.findIssueBranchPR(branch);
  if (pr)
    requireThat(
      (!branch || pr.head?.ref === branch) &&
        pr.head?.repo?.full_name === provider.config.repository &&
        pr.base?.repo?.full_name === provider.config.repository &&
        typeof pr.base?.ref === 'string',
      'The linked PR source or repository changed. Reconcile the PR on GitHub.'
    );
  return pr;
}

export async function flowRemoteBranches(provider) {
  const branches = await provider.gh([
    'api',
    `repos/${provider.config.repository}/branches?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | [.name, .commit.sha] | @tsv',
  ]);
  return new Map(
    branches
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
  );
}

export function flowPRLink(pr) {
  return { number: pr.number, url: pr.html_url, branch: pr.base.ref, state: pr.state, mergedAt: pr.merged_at };
}

export function assertFlowRemote(workspace, remote, repository, direction = 'push') {
  requireThat(
    typeof remote === 'string' && /^[\w.-]+$/.test(remote) && !remote.startsWith('-'),
    'Configure a valid publication remote.'
  );
  const url = git(workspace.checkout, 'remote', 'get-url', ...(direction === 'push' ? ['--push'] : []), remote);
  requireThat(
    [`git@github.com:${repository}`, `https://github.com/${repository}`].some(
      (address) => url === address || url === address + '.git'
    ),
    'The publication remote must match the configured GitHub repository without embedded credentials.'
  );
}

function committedCandidate(workspace) {
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  const tree = git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'Commit the verified working-tree snapshot before publishing. If its content is unchanged, its verification remains valid.'
  );
  return { head, tree, base: workspace.base };
}

function blockVerification(block, attempt = latestCurrentAttempt(block)) {
  if (attempt?.status !== 'completed' && !['publish', 'merge'].includes(block.kind)) return undefined;
  if (block.kind === 'verify') return attempt?.result;
  if (['publish', 'merge', 'update-branch'].includes(block.kind)) return attempt?.result?.verification;
}

export function flowVerificationHead(block) {
  const verification = blockVerification(block);
  return verification?.uncommitted ? undefined : verification?.head;
}

function publicationBlocker(pr, identity, target) {
  if (!pr) return null;
  if (pr.user?.login !== identity.slug + '[bot]') return 'This PR was opened manually on GitHub. Manage it there.';
  if (pr.base.ref !== target)
    return `GitHub changed the PR base to ${pr.base.ref}. Accept it in Destination before publishing.`;
  if (pr.merged_at) return 'This PR has already merged.';
  if (pr.state !== 'open') return 'Reopen this PR on GitHub before publishing again.';
  if (pr.draft) return 'Mark this PR ready for review on GitHub before publishing again.';
  return null;
}

function publicationCommitAvailable(workspace, revision) {
  try {
    git(workspace.checkout, 'cat-file', '-e', revision + '^{commit}');
    return true;
  } catch {
    return false;
  }
}

async function publicationTargetBlocker(workspace, target, revision, repository) {
  if (publicationCommitAvailable(workspace, revision)) return null;
  assertFlowRemote(workspace, target.remote, repository, 'fetch');
  try {
    await fetchIssueTarget(workspace.checkout, target, (command, args) =>
      execute(command, args, {
        cwd: workspace.checkout,
        env: cleanEnvironment(),
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    );
  } catch {
    return `Could not fetch ${target.remote}/${target.branch} for comparison. Check Git access to the destination, then retry Publish.`;
  }
  return publicationCommitAvailable(workspace, revision)
    ? null
    : 'The destination changed while preparing publication. Retry Publish to compare its current commit.';
}

async function noChangesPublication(workspace, target, head, pr, repository) {
  if (pr) return null;
  const blocker = await publicationTargetBlocker(workspace, target, target.revision, repository);
  if (blocker) return { status: 'blocked', message: blocker };
  let base;
  try {
    base = git(workspace.checkout, 'merge-base', target.revision, head);
  } catch (error) {
    return {
      status: 'blocked',
      message:
        error.status === 1
          ? 'The issue and destination have no common history locally. Choose a destination that shares the issue history or restore the missing Git history before retrying Publish.'
          : 'Could not compare the issue changes with the destination. Retry Publish after checking the issue checkout.',
    };
  }
  if (git(workspace.checkout, 'diff', '--name-only', base, head)) return null;
  return {
    status: 'blocked',
    message:
      'No changes to publish against the destination. You can close this issue as Cannot Reproduce or keep it open for more work.',
    suggestedResolution: 'cannot-reproduce',
  };
}

export async function prepareFlowPublication(service, ctx, workspace, options = {}) {
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  const { branch: target, remote } = deliveryTarget(ctx.flow);
  requireThat(target, 'Choose a destination on the configured remote before publishing.');
  requireThat(workspace.branch !== target, 'Publication must use the saved issue branch, separate from the target.');
  requireThat(provider.credentials, 'PR publication requires configured GitHub App credentials.');
  git(workspace.checkout, 'check-ref-format', '--branch', workspace.branch);
  const identity = await provider.credentials.session();
  assertFlowRemote(workspace, remote, provider.config.repository);
  const pr = Object.hasOwn(options, 'observedPR')
    ? options.observedPR
    : await lookupFlowPR(provider, workspace.branch, ctx.flow.destination?.pr ?? workspace.pr);
  const link = pr && flowPRLink(pr);
  const blocked = (message) => ({ preview: { status: 'blocked', message, pr: link } });
  const blocker = publicationBlocker(pr, identity, target);
  if (blocker) return blocked(blocker);
  const candidate = committedCandidate(workspace);
  const branches = await flowRemoteBranches(provider).catch(() => {
    throw Error('Couldn’t check branches. Retry Publish when GitHub is available.');
  });
  if (!branches.has(target)) return blocked('Branch unavailable. Choose another destination before publishing.');
  const noChanges = await noChangesPublication(
    workspace,
    { branch: target, remote, revision: branches.get(target) },
    candidate.head,
    pr,
    provider.config.repository
  );
  if (noChanges) return { preview: noChanges };
  if (service.sharedIssues) {
    const tracking = `refs/remotes/${remote}/${target}`;
    const base = git(workspace.checkout, 'merge-base', tracking, candidate.head);
    if (git(workspace.checkout, 'diff', '--name-only', base, candidate.head, '--', ...queueReportPaths()))
      return blocked('Shared issue report changes require a separate queue PR.');
  }
  const { fields, wording } = activeGroupRequest(ctx.issue, ctx.flow);
  const { goal, requestedProof } = fields ?? {};
  const title = ctx.issue.title;
  const body = pr
    ? undefined
    : [
        ['Goal', goal],
        ['Requested proof', requestedProof],
        ['Original wording', wording],
      ]
        .filter(([, value]) => value?.trim())
        .map(([label, value]) => `## ${label}\n\n${value}`)
        .join('\n\n');
  const previousHead = pr?.head.sha ?? branches.get(workspace.branch);
  const changes = {
    branch: workspace.branch,
    target,
    title,
    head: candidate.head,
    body,
    pr: link,
    previousTitle: pr?.title,
    previousHead,
    push: previousHead !== candidate.head,
    rename: Boolean(pr && pr.title !== title),
  };
  const preview = {
    ...changes,
    status: pr && !changes.push && !changes.rename ? 'current' : 'confirm',
    token: digest(JSON.stringify(changes)),
  };
  return { preview, candidate, provider, pr, remote };
}

async function preparePublicationAttempt(service, ctx, workspace, options) {
  const automatic = ctx.input?.automaticPublication === true;
  requireThat(
    automatic || ctx.input?.confirmed === true,
    'Confirm publication of this issue branch and PR explicitly.'
  );
  const prepared = await prepareFlowPublication(service, ctx, workspace, options);
  const { preview, provider, pr } = prepared;
  requireThat(preview.status !== 'blocked', preview.message);
  requireThat(
    automatic || preview.token === ctx.input.previewToken,
    'Publish changed. Review the updated preview before publishing.'
  );
  if (pr && preview.status === 'confirm') await assertPublicationIdle(provider, pr, workspace.branch);
  return prepared;
}

function retainPublicationFailure(error, { ctx, candidate, preview, folder, evidence }) {
  if (!Number.isInteger(error.githubStatus)) return;
  const path = join(folder, 'github-response.json');
  writeJson(path, {
    attemptId: ctx.attempt.id,
    status: error.githubStatus,
    response: error.githubResponse,
    head: candidate.head,
    target: preview.target,
    at: new Date().toISOString(),
  });
  evidence.push({
    key: 'githubResponse',
    path,
    label: 'Sanitized GitHub publication response',
    sha256: digest(readFileSync(path)),
  });
}

export async function publishFlowPR(service, ctx, workspace, folder, options) {
  const { preview, candidate, provider, pr, remote } = await preparePublicationAttempt(
    service,
    ctx,
    workspace,
    options
  );
  const log = join(folder, 'publish.log');
  const requirePreviewHead = () =>
    requireThat(
      committedCandidate(workspace).head === candidate.head,
      'Publish changed. Review the updated preview before publishing.'
    );
  const evidence = [];
  const completed = [];
  const result = (published) => ({
    pr: published.number,
    url: published.html_url,
    title: published.title,
    head: candidate.head,
    target: published.base?.ref ?? preview.target,
  });
  try {
    requirePreviewHead();
    if (preview.status === 'confirm')
      service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'implement', workspace.base);
    if (preview.push) {
      ctx.signal.throwIfAborted();
      await options.execute({
        command: 'git',
        args: ['push', remote, `${candidate.head}:refs/heads/${workspace.branch}`],
        cwd: workspace.checkout,
        log,
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      });
      evidence.push({ key: 'log', path: log, label: 'Issue branch publication output' });
      completed.push('Pushed the issue commit.');
    }
    ctx.signal.throwIfAborted();
    requirePreviewHead();
    ctx.onProgress('Writing the GitHub PR.\n', true);
    const published = await updateFlowPR(ctx, workspace, provider, pr, preview, options);
    return {
      result: { ...result(published), title: published.title || preview.title },
      evidence,
      workspace: { ...workspace, pr: published.number },
      summary: preview.status === 'current' ? 'PR is up to date.' : 'Published the issue PR.',
    };
  } catch (error) {
    retainPublicationFailure(error, { ctx, candidate, preview, folder, evidence });
    if (!completed.length) {
      error.evidence = [...evidence, ...(error.evidence ?? [])];
      throw error;
    }
    const current = (await lookupFlowPR(provider, workspace.branch, pr?.number).catch(() => null)) || pr;
    return {
      status: 'blocked',
      summary: `${error.githubStatus === 422 ? 'Publication blocked.' : 'Needs retry.'} ${completed.join(' ')} ${error.message}`,
      result: current
        ? { ...result(current), head: current.head?.sha, completed }
        : { head: candidate.head, completed },
      evidence,
      workspace: current ? { ...workspace, pr: current.number } : workspace,
    };
  }
}

function publicationMatches(pr, latest, preview, head) {
  return (
    (latest?.number ?? null) === (pr?.number ?? null) &&
    (!latest ||
      (latest.state === 'open' &&
        !latest.draft &&
        latest.base.ref === preview.target &&
        latest.title === pr.title &&
        latest.head.sha === head))
  );
}

async function updateFlowPR(ctx, workspace, provider, pr, preview, options) {
  let latest = await lookupFlowPR(provider, workspace.branch, pr?.number);
  for (
    let poll = 0;
    poll < 15 && pr && preview.push && publicationMatches(pr, latest, preview, preview.previousHead);
    poll++
  ) {
    ctx.onProgress('Waiting for GitHub to observe the pushed PR commit.\n', true);
    await (options.publicationDelay ?? delay)(1000, undefined, { signal: ctx.signal });
    latest = await lookupFlowPR(provider, workspace.branch, pr.number);
  }
  requireThat(
    publicationMatches(pr, latest, preview, preview.head),
    'The GitHub PR changed during publication. Review Publish again.'
  );
  ctx.signal.throwIfAborted();
  if (!latest) return provider.publish(workspace, preview.head, { title: preview.title, body: preview.body });
  if (!preview.rename) return latest;
  await assertPublicationIdle(provider, latest, workspace.branch);
  ctx.signal.throwIfAborted();
  const published = JSON.parse(
    await provider.gh([
      'api',
      `repos/${provider.config.repository}/pulls/${latest.number}`,
      '--method',
      'PATCH',
      '-f',
      'title=' + preview.title,
    ])
  );
  requireThat(published.title === preview.title, 'GitHub did not confirm the PR title update.');
  return published;
}

export async function assertPublicationIdle(provider, pr, branch) {
  const { config } = provider;
  requireThat(
    pr.state === 'open' &&
      !pr.merged_at &&
      pr.head?.ref === branch &&
      pr.head.repo?.full_name === config.repository &&
      pr.base?.ref === config.target &&
      pr.base.repo?.full_name === config.repository,
    'The existing PR is closed, merged or has a different source or target. Reconcile it before publication.'
  );
  requireThat(!pr.auto_merge, 'Remove this PR from auto-merge before publishing a candidate.');
  const [owner, name] = config.repository.split('/');
  const result = JSON.parse(
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
  const observed = result.data?.repository?.pullRequest;
  requireThat(
    observed && !observed.autoMergeRequest && !observed.mergeQueueEntry,
    'Remove this PR from auto-merge and the merge queue before publishing a candidate.'
  );
}

function deliveryWorkProof(ctx, candidate) {
  const requested = activeGroupRequest(ctx.issue, ctx.flow).fields?.requestedProof;
  const work = upstreamBlocks(ctx.block, ctx.flow.blocks).filter(({ kind }) => kind === 'work');
  return {
    requested,
    attempts: work.map((block) => {
      const attempt = latestCurrentAttempt(block);
      const file = attempt?.artifacts?.files?.proof;
      const tree = attempt?.result?.tree;
      const record = { blockId: block.id, attemptId: attempt?.id, tree };
      if (attempt?.status !== 'completed' || !file?.sha256) return { ...record, status: 'missing' };
      if (tree !== candidate.tree) return { ...record, status: 'different-tree' };
      try {
        if (digest(readFileSync(evidencePath(ctx.evidenceRoot, file.path, file.sha256))) === file.sha256)
          return { ...record, status: 'retained', file };
      } catch {
        // A missing proof file is recorded as a gap.
      }
      return { ...record, status: 'unavailable' };
    }),
  };
}

export async function flowClosureArtifact(service, ctx, workspace, folder, options = {}) {
  ctx = { ...ctx, evidenceRoot: service.root };
  requireThat(ctx.input?.confirmed === true, 'Accept the recorded result explicitly before closing this issue.');
  const type = ctx.details?.type ?? requestData(ctx.flow).fields?.type ?? ctx.flow.routeType;
  requireThat(issueTypes.includes(type), 'Missing issue type. Set the issue type in Request before closing.');
  if (type === 'investigation') return investigationClosureArtifact(ctx, workspace);
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  const merged = mergedDelivery(ctx.flow);
  const pr = merged ? { number: merged.pr } : await provider.findByBranch(workspace.branch, provider.config.target);
  requireThat(pr, 'No PR exists for this issue branch. Publish and merge its PR before closing.');
  const delivered = await provider.inspectExternalDelivery(pr.number, { requiredChecksOnly: true });
  assertMatchingDelivery(ctx.flow, workspace, pr.number, delivered, merged);
  const [retained] = groupChildren(ctx.issue).length ? await hydrateProjectEvidence(service, ctx.issue.id) : [];
  return recordClosureDelivery(ctx, workspace, folder, delivered, merged?.verification, retained?.manifest.groupProof);
}

function assertMatchingDelivery(flow, workspace, number, delivered, merged) {
  const expected = [
    delivered.number === number,
    delivered.branch === workspace.branch,
    delivered.target === deliveryTarget(flow).branch,
    delivered.mergedAt,
    delivered.mergeCommit,
    delivered.targetRevision,
    delivered.head === (merged?.head ?? delivered.head),
    delivered.mergeCommit === (merged?.revision ?? delivered.mergeCommit),
  ];
  requireThat(
    expected.every(Boolean),
    'The merged PR does not match the recorded issue candidate and target. Reconcile its delivery before accepting.'
  );
}

function recordClosureDelivery(ctx, workspace, folder, delivered, verification, retained) {
  const candidate = {
    head: delivered.head,
    tree: git(workspace.checkout, 'rev-parse', delivered.head + '^{tree}'),
    verification,
  };
  const groupEvidence = requireGroupProof(
    ctx.issue,
    ctx.flow,
    candidate.tree,
    ctx.block,
    ctx.evidenceRoot,
    ctx.issue.issue_group ? recheckedGroupProof(workspace.checkout, candidate, ctx.evidenceRoot) : undefined,
    retained?.head === candidate.head && retained.tree === candidate.tree ? retained.file : undefined
  );
  ctx.signal.throwIfAborted();
  const path = join(folder, 'merged-delivery.json');
  const workProof = deliveryWorkProof(ctx, candidate);
  writeJson(path, { ...delivered, candidateTree: candidate.tree, workProof });
  return {
    revision: candidate.head,
    checkout: workspace.checkout,
    ...(groupEvidence.length && { groupProof: true }),
    evidence: [
      ...workProof.attempts.flatMap(({ file }) => (file ? [file] : [])),
      ...groupEvidence,
      { path, sha256: digest(readFileSync(path)) },
    ],
  };
}

function retainedInvestigationProof(root, proof) {
  try {
    const path = evidencePath(root, proof.path, proof.sha256);
    return existsSync(path) && digest(readFileSync(path)) === proof.sha256;
  } catch {
    return false;
  }
}

function investigationClosureArtifact(ctx, workspace) {
  const saved = ctx.flow.workspace;
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  const tree = git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    saved?.checkout === workspace.checkout &&
      saved.branch === workspace.branch &&
      saved.base === workspace.base &&
      (startingPoint(ctx.flow)?.commit ?? deliveryTarget(ctx.flow).base ?? saved.base) === workspace.base &&
      head === workspace.base &&
      git(workspace.checkout, 'branch', '--show-current') === workspace.branch &&
      !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'Investigation closure requires its clean saved checkout at the original base. Preserve edits and use the code delivery flow for changed source.'
  );
  requireThat(
    !ctx.flow.blocks.some((block) => {
      const attempt = block.attempts.at(-1);
      return (
        ['running', 'stopping', 'uncertain'].includes(attempt?.status) &&
        !(block.kind === 'close' && attempt.id === ctx.attempt.id)
      );
    }),
    'Reconcile active or uncertain blocks before accepting this investigation.'
  );
  const attempt = upstreamBlocks(ctx.block, ctx.flow.blocks)
    .filter((block) => ['understand', 'investigate', 'advice', 'playbook'].includes(block.kind))
    .map(latestCurrentAttempt)
    .findLast(
      (attempt) =>
        attempt?.status === 'completed' &&
        attempt.result?.head === head &&
        attempt.result.base === workspace.base &&
        attempt.result.tree === tree
    );
  requireThat(
    attempt?.output?.trim() && attempt.evidence?.length,
    'Complete an Investigate, Understand, or advisory block for this exact investigation checkout before closing.'
  );
  const evidence = attempt.evidence.map((proof) => {
    requireThat(
      typeof proof.path === 'string' && /^[a-f0-9]{64}$/.test(proof.sha256 || ''),
      'Investigation output has no recorded immutable digest. Run its inquiry or advisory block again.'
    );
    requireThat(
      retainedInvestigationProof(ctx.evidenceRoot, proof),
      'Retained investigation evidence changed or is missing. Run its inquiry or advisory block again.'
    );
    return { path: proof.path, sha256: proof.sha256 };
  });
  requireThat(
    evidence.some(
      (proof) => readFileSync(evidencePath(ctx.evidenceRoot, proof.path, proof.sha256), 'utf8') === attempt.output
    ),
    'The completed investigation output is missing from its retained evidence. Run its block again.'
  );
  ctx.signal.throwIfAborted();
  const groupEvidence = requireGroupProof(ctx.issue, ctx.flow, tree, ctx.block, ctx.evidenceRoot);
  return {
    revision: head,
    checkout: workspace.checkout,
    ...(groupEvidence.length && { groupProof: true }),
    evidence: [...evidence, ...groupEvidence],
  };
}
