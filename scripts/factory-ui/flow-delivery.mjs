import {
  deliveryTarget,
  latestCurrentAttempt,
  requestData,
  startingPoint,
  upstreamBlocks,
} from './flow-block-data.mjs';
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
    'The verified candidate changed. Preserve its changes in a commit and run verification again.'
  );
  return { head, tree, base: workspace.base };
}

function blockVerification(block, attempt = latestCurrentAttempt(block)) {
  if (attempt?.status !== 'completed' && !['publish', 'merge'].includes(block.kind)) return undefined;
  if (block.kind === 'verify') return attempt?.result;
  if (['publish', 'merge'].includes(block.kind)) return attempt?.result?.verification;
}

export function flowVerificationHead(block) {
  const verification = blockVerification(block);
  return verification?.uncommitted ? undefined : verification?.head;
}

export function verifiedFlowCandidate(ctx, workspace, options = {}) {
  const candidate = committedCandidate(workspace);
  const previous = ctx.block.attempts?.filter((attempt) => attempt.id !== ctx.attempt?.id).at(-1);
  const checks = [
    options.verification,
    previous?.invalidatedAt ? undefined : blockVerification(ctx.block, previous ?? {}),
    ...upstreamBlocks(ctx.block, ctx.flow.blocks)
      .toReversed()
      .map((block) => blockVerification(block)),
  ];
  const current = checks.filter((checked) => !checked?.uncommitted && checked?.head === candidate.head);
  requireThat(
    current.some((checked) => checked.proof?.length >= 2),
    'Run an explicit Verify block for this exact issue candidate. Required independent verification and step evidence are missing.'
  );
  let failure;
  for (const checked of current) {
    try {
      return { ...candidate, verification: checked, evidence: verifyEvidence(candidate, checked, options) };
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

function verifyEvidence({ tree, base }, checked, options) {
  requireThat(
    checked.tree === tree && checked.base === base && checked.proof?.length >= 2,
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
    (options.validateSummary || validateSummary)(summary, base, tree, { auditPolicy: 'required' });
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
  return evidence;
}

export async function ensureFlowVerification(service, ctx, workspace, folder, options) {
  const before = committedCandidate(workspace);
  try {
    return verifiedFlowCandidate(ctx, workspace, options);
  } catch (error) {
    if (!options.verifyCandidate) throw error;
  }
  service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, 'verify', workspace.base);
  ctx.onProgress('Running independent Verify checks on the issue commit.\n');
  const { result, evidence } = await options.verifyCandidate(ctx, workspace, folder);
  ctx.signal.throwIfAborted();
  const checked = verifiedFlowCandidate(ctx, workspace, { ...options, verification: result });
  requireThat(
    checked.head === before.head,
    'The issue commit changed during verification. Review the candidate again.'
  );
  const verificationEvidence = evidence.map(({ key, ...entry }) => ({ ...entry, key: 'verification-' + key }));
  return { ...checked, evidence: [...checked.evidence, ...verificationEvidence] };
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
  const { goal, requestedProof } = requestData(ctx.flow).fields ?? {};
  const wording = requestData(ctx.flow).wording;
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

export async function publishFlowPR(service, ctx, workspace, folder, options) {
  requireThat(ctx.input?.confirmed === true, 'Confirm publication of this issue branch and PR explicitly.');
  const { preview, candidate, provider, pr, remote } = await prepareFlowPublication(service, ctx, workspace, options);
  requireThat(preview.status !== 'blocked', preview.message);
  requireThat(
    preview.token === ctx.input.previewToken,
    'Publish changed. Review the updated preview before publishing.'
  );
  if (pr && preview.status === 'confirm') await assertPublicationIdle(provider, pr, workspace.branch);
  const log = join(folder, 'publish.log');
  const checked = await ensureFlowVerification(service, ctx, workspace, join(folder, 'verification'), options);
  requireThat(checked.head === candidate.head, 'Publish changed. Review the updated preview before publishing.');
  const verification = { ...options, verification: checked.verification };
  const evidence = [...checked.evidence];
  const completed = [];
  const result = (published) => ({
    pr: published.number,
    url: published.html_url,
    head: candidate.head,
    target: published.base?.ref ?? preview.target,
    verification: checked.verification,
  });
  try {
    verifiedFlowCandidate(ctx, workspace, verification);
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
      completed.push('Pushed the verified commit.');
    }
    ctx.signal.throwIfAborted();
    verifiedFlowCandidate(ctx, workspace, verification);
    const published = await updateFlowPR(ctx, workspace, provider, pr, preview);
    return {
      result: result(published),
      evidence,
      workspace: { ...workspace, pr: published.number },
      summary: preview.status === 'current' ? 'PR is up to date.' : 'Published the verified issue PR.',
    };
  } catch (error) {
    if (!completed.length) {
      error.deliveryVerification = checked.verification;
      error.evidence = [...evidence, ...(error.evidence ?? [])];
      throw error;
    }
    const current = (await lookupFlowPR(provider, workspace.branch, pr?.number).catch(() => null)) || pr;
    return {
      status: 'blocked',
      summary: `Needs retry. ${completed.join(' ')} ${error.message}`,
      result: current
        ? { ...result(current), head: current.head?.sha, completed }
        : { head: candidate.head, completed, verification: checked.verification },
      evidence,
      workspace: current ? { ...workspace, pr: current.number } : workspace,
    };
  }
}

async function updateFlowPR(ctx, workspace, provider, pr, preview) {
  const latest = await lookupFlowPR(provider, workspace.branch, pr?.number);
  requireThat(
    (latest?.number ?? null) === (pr?.number ?? null) &&
      (!latest ||
        (latest.state === 'open' &&
          !latest.draft &&
          latest.base.ref === preview.target &&
          latest.title === pr.title &&
          latest.head.sha === preview.head)),
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

export async function flowClosureArtifact(service, ctx, workspace, folder, options = {}) {
  requireThat(ctx.input?.confirmed === true, 'Accept the recorded result explicitly before closing this issue.');
  const type = ctx.details ? ctx.details.type : requestData(ctx.flow).fields?.type;
  requireThat(type, 'Missing issue type. Refresh Request before closing.');
  if (type === 'investigation') return investigationClosureArtifact(ctx, workspace);
  const candidate = verifiedFlowCandidate(ctx, workspace, options);
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  const pr = await provider.findByBranch(workspace.branch, provider.config.target);
  requireThat(pr, 'No PR exists for this issue branch. Publish and merge its PR before closing.');
  const delivered = await provider.inspectExternalDelivery(pr.number, { requiredChecksOnly: true });
  requireThat(
    delivered.number === pr.number &&
      delivered.head === candidate.head &&
      delivered.branch === workspace.branch &&
      delivered.target === deliveryTarget(ctx.flow).branch &&
      delivered.mergedAt &&
      delivered.mergeCommit &&
      delivered.targetRevision,
    'The merged PR does not match the verified issue candidate and target. Reconcile its delivery before accepting.'
  );
  ctx.signal.throwIfAborted();
  requireThat(
    verifiedFlowCandidate(ctx, workspace, options).head === candidate.head,
    'The issue candidate changed while checking its merged PR. Review the current result before accepting.'
  );
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
    .filter((block) => ['understand', 'advice', 'playbook'].includes(block.kind))
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
