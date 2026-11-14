import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { validateSummary } from './checks.mjs';
import { StrategyProvider } from './strategy-provider.mjs';

export function flowDeliveryProvider(service, ctx, workspace, options = {}) {
  const path = join(service.root, '.issues/issue-delivery-config.json');
  requireThat(
    existsSync(path),
    'Configure .issues/issue-delivery-config.json before publishing or delivering this issue PR.'
  );
  const config = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(
    config.provider === 'github' &&
      /^[\w.-]+\/[\w.-]+$/.test(config.repository) &&
      config.target === ctx.flow.target.branch &&
      config.remote === ctx.flow.target.remote,
    'The saved flow and protected delivery repository, remote or target differ. Reconcile their configuration first.'
  );
  return options.provider || new StrategyProvider(workspace.checkout, config, service.root);
}

export function verifiedFlowCandidate(ctx, workspace, options = {}) {
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  const tree = git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');
  const verification = ctx.flow.blocks
    .filter((block) => block.kind === 'verify')
    .flatMap((block) => block.attempts)
    .findLast(
      (attempt) => attempt.status === 'completed' && !attempt.result?.uncommitted && attempt.result?.head === head
    );
  requireThat(
    verification?.result?.proof?.length >= 2,
    'Run an explicit Verify block for this exact issue candidate. Required independent verification and step evidence are missing.'
  );
  const checked = verification.result;
  requireThat(
    checked.tree === tree &&
      checked.base === workspace.base &&
      !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'The verified candidate changed. Preserve its changes and run an explicit Verify block again.'
  );
  const checkpoints = new Set();
  const evidence = [];
  for (const proof of checked.supportingProof || []) {
    requireThat(
      digest(readFileSync(proof.path)) === proof.sha256,
      'Supporting verification evidence changed. Run an explicit Verify block again.'
    );
    evidence.push(proof);
  }
  for (const proof of checked.proof) {
    const bytes = readFileSync(proof.path);
    requireThat(
      digest(bytes) === proof.sha256,
      'The retained verification evidence changed. Run an explicit Verify block again.'
    );
    const summary = JSON.parse(bytes);
    (options.validateSummary || validateSummary)(summary, workspace.base, tree, { auditPolicy: 'required' });
    checkpoints.add(summary.checkpoint);
    evidence.push(proof);
    for (const check of summary.checks || []) {
      requireThat(
        (checked.supportingProof || []).some((file) => file.path === check.log),
        'Immutable command evidence is missing. Run an explicit Verify block again.'
      );
      for (const file of check.artifacts || [])
        requireThat(
          (checked.supportingProof || []).some((proof) => proof.path === file.path && proof.sha256 === file.sha256),
          'Immutable browser evidence is missing. Run an explicit Verify block again.'
        );
    }
  }
  requireThat(
    checkpoints.has('verification') && checkpoints.has('step'),
    'Both independent verification and step checkpoints are required before delivery.'
  );
  return { head, tree, base: workspace.base, evidence };
}

export async function publishFlowPR(service, ctx, workspace, folder, options) {
  requireThat(ctx.input?.confirmed === true, 'Confirm publication of this issue branch and PR explicitly.');
  const candidate = verifiedFlowCandidate(ctx, workspace, options);
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  requireThat(provider.credentials, 'PR publication requires configured GitHub App credentials.');
  const identity = await provider.credentials.session();
  const { config } = provider;
  requireThat(
    workspace.branch !== config.target,
    'Publication must use the saved issue branch, separate from the target.'
  );
  git(workspace.checkout, 'check-ref-format', '--branch', workspace.branch);
  requireThat(
    /^[\w.-]+$/.test(config.remote) && !config.remote.startsWith('-'),
    'Configure a valid publication remote.'
  );
  const url = git(workspace.checkout, 'remote', 'get-url', '--push', config.remote);
  requireThat(
    url === `git@github.com:${config.repository}.git` ||
      url === `git@github.com:${config.repository}` ||
      url === `https://github.com/${config.repository}.git` ||
      url === `https://github.com/${config.repository}`,
    'The publication remote must match the configured GitHub repository without embedded credentials.'
  );
  const existing = await provider.findByBranch(workspace.branch, config.target);
  if (existing) {
    requireThat(
      existing.user?.login === identity.slug + '[bot]',
      'This issue PR was opened by a personal account. Preserve its authorship and request an explicit replacement decision before publication.'
    );
    await assertPublicationIdle(provider, existing, workspace.branch);
  }
  service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'implement', workspace.base);
  ctx.signal.throwIfAborted();
  const log = join(folder, 'publish.log');
  await options.execute({
    command: 'git',
    args: ['push', config.remote, `${candidate.head}:refs/heads/${workspace.branch}`],
    cwd: workspace.checkout,
    log,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
  ctx.signal.throwIfAborted();
  verifiedFlowCandidate(ctx, workspace, options);
  const publication = {
    title: ctx.issue.title || ctx.flow.request.goal || 'Complete issue work',
    body: [
      ctx.flow.request.goal || ctx.issue.title,
      ctx.block.prompt || '',
      `Verified candidate ${candidate.head}.`,
      'Independent verification and the step audit passed for this exact candidate. Publication does not imply merge or acceptance.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
  const pr = await provider.publish(workspace, candidate.head, publication);
  return {
    result: { pr: pr.number, url: pr.html_url, head: candidate.head },
    evidence: [{ path: log, label: 'Issue branch publication output' }],
    workspace: { ...workspace, pr: pr.number },
  };
}

async function assertPublicationIdle(provider, pr, branch) {
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

export async function flowClosureArtifact(service, ctx, workspace, folder, options = {}) {
  requireThat(ctx.input?.confirmed === true, 'Accept the recorded result explicitly before closing this issue.');
  if (ctx.flow.type === 'investigation') return investigationClosureArtifact(ctx, workspace);
  const candidate = verifiedFlowCandidate(ctx, workspace, options);
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  const pr = await provider.findByBranch(workspace.branch, provider.config.target);
  requireThat(pr, 'No PR exists for this issue branch. Publish and merge its PR before closing.');
  const delivered = await provider.inspectExternalDelivery(pr.number);
  requireThat(
    delivered.number === pr.number &&
      delivered.head === candidate.head &&
      delivered.branch === workspace.branch &&
      delivered.target === ctx.flow.target.branch &&
      delivered.mergedAt &&
      delivered.mergeCommit &&
      delivered.targetRevision,
    'The merged PR does not match the verified issue candidate and target. Reconcile its delivery before accepting.'
  );
  ctx.signal.throwIfAborted();
  verifiedFlowCandidate(ctx, workspace, options);
  const path = join(folder, 'merged-delivery.json');
  writeJson(path, delivered);
  return {
    revision: candidate.head,
    checkout: workspace.checkout,
    evidence: [...candidate.evidence, { path, sha256: digest(readFileSync(path)) }],
  };
}

function investigationClosureArtifact(ctx, workspace) {
  const saved = ctx.flow.workspace;
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  const tree = git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    saved?.checkout === workspace.checkout &&
      saved.branch === workspace.branch &&
      saved.base === workspace.base &&
      ctx.flow.target.base === workspace.base &&
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
  const attempt = ctx.flow.blocks
    .filter((block) => ['understand', 'advice', 'playbook'].includes(block.kind))
    .map((block) => block.attempts.at(-1))
    .findLast(
      (attempt) =>
        attempt?.status === 'completed' &&
        attempt.result?.head === head &&
        attempt.result.base === workspace.base &&
        attempt.result.tree === tree
    );
  requireThat(
    attempt?.output?.trim() && attempt.evidence?.length,
    'Complete an Understand or advisory block for this exact investigation checkout before closing.'
  );
  const evidence = attempt.evidence.map((proof) => {
    requireThat(
      typeof proof.path === 'string' && /^[a-f0-9]{64}$/.test(proof.sha256 || ''),
      'Investigation output has no recorded immutable digest. Run its Understand or advisory block again.'
    );
    requireThat(
      existsSync(proof.path) && digest(readFileSync(proof.path)) === proof.sha256,
      'Retained investigation evidence changed or is missing. Run its Understand or advisory block again.'
    );
    return { path: proof.path, sha256: proof.sha256 };
  });
  requireThat(
    evidence.some((proof) => readFileSync(proof.path, 'utf8') === attempt.output),
    'The completed investigation output is missing from its retained evidence. Run its block again.'
  );
  ctx.signal.throwIfAborted();
  return { revision: head, checkout: workspace.checkout, evidence };
}
