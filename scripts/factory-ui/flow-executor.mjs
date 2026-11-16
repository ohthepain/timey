import { BlockCatalog } from './block-catalog.mjs';
import { blockDefinitionId, deliveryTarget, startingPoint, upstreamBlocks } from './flow-block-data.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  statSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createIssueChatConnection, attachIssueChat } from './issue-chat-runtime.mjs';
import { conversationState, saveConversationState, appendMessage } from './conversation-store.mjs';
import { listAvailableSkills, selectedSkills, skillInputs } from './skills.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import {
  deleteIssueWorktree,
  issueCleanupRecord,
  issueHasActiveWork,
  retryIssueCleanup,
  runFlowCleanup,
  worktreeCleanupService,
} from './issue-cleanup.mjs';
import { decideIssue } from './issue-decision.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { readQueue } from './data.mjs';
import { git, cleanEnvironment, requireThat, writeJson, digest } from './common.mjs';
import { redactValue } from './activity.mjs';
import { flowClosureArtifact, publishFlowPR } from './flow-delivery.mjs';
import { mergeFlowPR } from './flow-merge.mjs';
import {
  flowVerificationInput,
  runFlowVerification,
  runWorkVerification,
  resumeWorkDependencies,
  workVerificationScript,
} from './flow-verification.mjs';
import { startingBranchUpstream, updateIssueBranch } from './flow-update-branch.mjs';
import { runRetro } from './flow-retro.mjs';

const readOnlyBlocks = new Set(['request', 'refine', 'sharpen', 'understand', 'retro', 'advice', 'playbook', 'sol']);
const commandBlocks = new Set([
  'verify',
  'update-branch',
  'publish',
  'merge',
  'retro',
  'close',
  'cleanup',
  'delete-worktree',
]);
const maxWorkRepairs = 3;

export function createFlowExecutor(service, options = {}) {
  const active = new Map();
  let closed = false;
  const create = options.createConnection || createIssueChatConnection;
  const executeCommandImpl = options.execute || executeCommand;
  const attach = options.attach || attachIssueChat;
  const catalog = new BlockCatalog(service.root);
  return {
    async run(ctx) {
      requireThat(!closed, 'The block executor is closed. Restart the server before running another block.');
      requireThat(
        !active.has(ctx.issue.id),
        'A block for this issue is already running. Stop it before starting another.'
      );
      const scopedService = operationService(service, ctx.issue.id);
      assertIdle(scopedService, ctx.issue.id);
      const definition =
        ctx.definition ?? catalog.read().entries.find((entry) => entry.id === blockDefinitionId(ctx.block));
      const command = commandBlocks.has(ctx.block.kind);
      requireThat(
        command || (definition?.usable && definition.prompt),
        'Add a System prompt to this block’s Markdown.'
      );

      const controller = new AbortController();
      const forward = () => controller.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener('abort', forward, { once: true });
      if (ctx.signal?.aborted) forward();
      const owned = { controller, connection: null };
      active.set(ctx.issue.id, owned);
      const onStep = (text) => ctx.onStep?.(redactValue(String(text)).trim().slice(0, 500));
      const context = {
        ...ctx,
        definition,
        signal: controller.signal,
        onProgress: (text, step = false) => {
          if (step) onStep(text);
          ctx.onProgress?.(redactValue(String(text)).slice(-2000));
        },
        onStep,
      };
      const execute = (input) => {
        context.onStep(input.label ?? [input.command, ...input.args].join(' '));
        return executeCommandImpl(input);
      };
      const verifyCandidate =
        options.verifyCandidate || ((ctx, workspace, folder) => runFlowVerification(ctx, workspace, folder, execute));
      const verifyWork =
        options.verifyWork || ((ctx, workspace, folder) => runWorkVerification(ctx, workspace, folder, execute));
      const prepareWorkDependencies = (ctx, workspace, folder) =>
        resumeWorkDependencies(ctx, workspace, folder, execute);
      try {
        context.signal.throwIfAborted();
        service.ownServer();
        const runtime = {
          create,
          attach,
          ...options,
          execute,
          verifyCandidate,
          verifyWork,
          prepareWorkDependencies,
          verificationInput: options.verificationInput ?? flowVerificationInput,
        };
        if (command) context.onStep('Running ' + (ctx.block.label || ctx.block.kind) + '.');
        if (!command && context.block.kind === 'work')
          await prepareWorkDependencies(
            context,
            await workspaceFor(service, context),
            evidenceDirectory(service, context)
          );
        const result = !command
          ? await runModel(service, context, owned, runtime)
          : await runReconciledCommand(scopedService, context, {
              ...runtime,
              repair:
                options.repair ??
                ((error, round) => runMergeRepair(scopedService, context, owned, runtime, error, round)),
              resolveBranchConflicts: (paths, target) =>
                runBranchConflictRepair(scopedService, context, owned, runtime, paths, target),
            });
        return command && !result.artifacts ? { ...result, artifacts: commandArtifacts(definition, result) } : result;
      } finally {
        ctx.signal?.removeEventListener('abort', forward);
        owned.connection?.close();
        active.delete(ctx.issue.id);
      }
    },
    close() {
      closed = true;
      for (const owned of active.values())
        owned.controller.abort(Error('The executor closed. Reconcile the saved block before retrying.'));
    },
  };
}

function operationService(service, issueId) {
  const scoped = Object.create(service);
  scoped.flowOperationIssueId = issueId;
  if (!service.flows) return scoped;
  scoped.flows = Object.create(service.flows);
  scoped.flows.active = new Map([...service.flows.active].filter(([id]) => id !== issueId));
  return scoped;
}

function assertIdle(service, issueId) {
  requireThat(
    !issueHasActiveWork(service, issueId),
    'Legacy issue work or chat is active. Stop or finish its current operation first.'
  );
  requireThat(
    !service.issueChats?.active?.has(issueId),
    'The issue chat is active. Stop or finish its current response first.'
  );
  const queue = service.issueChats?.scheduler?.view(issueId);
  requireThat(
    !queue?.operation && !queue?.activeTurn && !queue?.entries?.length,
    'The issue has a saved chat operation or queued prompts. Reconcile them before running a block.'
  );
  const registryPath = join(service.root, '.issues/factory.json');
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : null;
  requireThat(
    !registry || (registry.version === 1 && Array.isArray(registry.actions)),
    'The legacy dispatch registry needs reconciliation.'
  );
  const actions = registry?.actions || [];
  requireThat(
    !actions.some(
      (action) =>
        action.issues.includes(issueId) &&
        ['reserved', 'setup', 'running', 'blocked', 'completed'].includes(action.status)
    ),
    'A legacy assignment still owns this issue. Reconcile that assignment before running a block.'
  );
}

async function workspaceFor(service, ctx, prepare = true) {
  const record = service.lifecycleRuns[ctx.issue.id] || {
    id: randomUUID(),
    issueId: ctx.issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  const saved = record.work || record.chatCheckout || ctx.flow.workspace;
  requireThat(prepare || saved?.checkout, 'The issue needs a saved checkout before accepting its result.');
  const workspace = saved?.checkout
    ? { checkout: saved.checkout, branch: saved.branch, base: saved.base }
    : {
        checkout: join(service.root, '.issues/issue-work', ctx.issue.id),
        branch: `codex/issue-${ctx.issue.issueNumber ?? ctx.issue.id}`,
        base: startingRevision(service.root, ctx.flow),
      };
  const managed = realpathSync(join(service.root, '.issues'));
  const path = resolve(workspace.checkout);
  const local = relative(managed, path);
  requireThat(
    local && local !== '..' && !local.startsWith(`..${sep}`) && !local.startsWith(sep),
    'The issue checkout must be inside its managed .issues folder.'
  );
  requireThat(
    workspace.branch && workspace.branch !== deliveryTarget(ctx.flow).branch,
    'Issue work must use its saved branch, separate from the target.'
  );
  if (!saved?.checkout) {
    requireThat(!existsSync(path), 'An existing issue folder needs reconciliation. It was not replaced.');
    mkdirSync(join(service.root, '.issues/issue-work'), { recursive: true });
    saveLifecycle(service, record, { chatCheckout: { ...workspace } });
    git(service.root, 'worktree', 'add', '-b', workspace.branch, path, workspace.base);
  }
  requireThat(
    existsSync(path),
    'The saved issue checkout is missing. Restore it or explicitly reconcile the saved workspace.'
  );
  const canonical = realpathSync(path);
  const canonicalRelative = relative(managed, canonical);
  requireThat(
    canonicalRelative &&
      canonicalRelative !== '..' &&
      !canonicalRelative.startsWith(`..${sep}`) &&
      !canonicalRelative.startsWith(sep),
    'The checkout resolves outside the managed issue folder.'
  );
  requireThat(
    git(canonical, 'branch', '--show-current') === workspace.branch,
    'The saved issue checkout changed branches. Reconcile it before running this block.'
  );
  requireThat(
    realpathSync(git(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir')) ===
      realpathSync(git(service.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    'The saved checkout belongs to another repository.'
  );
  git(canonical, 'rev-parse', '--verify', workspace.base);
  workspace.checkout = canonical;
  if (prepare && !record.work) saveLifecycle(service, record, { chatCheckout: { ...workspace } });
  await ctx.onWorkspace?.(workspace);
  return workspace;
}

export async function manualFlowClosureArtifact(service, issue, flow, options) {
  const ctx = {
    issue,
    flow,
    block: {},
    attempt: { id: randomUUID() },
    input: { confirmed: true },
    signal: new AbortController().signal,
  };
  if (usesLegacyDelivery(service, ctx) || !flow.workspace?.checkout) return null;
  const workspace = await workspaceFor(service, ctx, false);
  return flowClosureArtifact(service, ctx, workspace, evidenceDirectory(service, ctx), options);
}

function startingRevision(root, flow) {
  const point = startingPoint(flow);
  if (point) {
    const commit = point.commit;
    requireThat(
      typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
      'The saved starting commit needs reconciliation before creating its workspace.'
    );
    const resolved = git(root, 'rev-parse', '--verify', `${commit}^{commit}`);
    requireThat(resolved === commit, 'The saved starting commit could not be verified exactly.');
    return commit;
  }
  const target = flow.target;
  if (target.base) return git(root, 'rev-parse', '--verify', target.base);
  try {
    return git(root, 'rev-parse', '--verify', `refs/remotes/${target.remote}/${target.branch}`);
  } catch {
    return git(root, 'rev-parse', '--verify', `refs/heads/${target.branch}`);
  }
}

function guardBlock(service, ctx, operation, base) {
  requireThat(
    existsSync(join(service.root, '.issues/triage-labels.md')),
    'Project setup is incomplete: lifecycle configuration is missing. Open Project settings (the gear beside Flow) to initialize it, or restore .issues/triage-labels.md if this project uses custom states. Editable work and verification require this file. Read-only blocks remain available.'
  );
  service.guard(service.root, { id: ctx.attempt.id, issues: [ctx.issue.id] }, operation, base);
}

function evidenceDirectory(service, ctx) {
  const folder = join(service.root, '.issues/factory-ui/flow-evidence', ctx.attempt.id);
  requireThat(/^[A-Za-z0-9_-]{1,120}$/.test(ctx.attempt.id), 'Use a valid block attempt identity.');
  mkdirSync(folder, { recursive: true });
  return folder;
}

function blockInput(ctx, extra = {}) {
  return JSON.stringify(
    {
      block: ctx.block.label || ctx.block.kind,
      details: (ctx.attempt.details ?? []).map(({ key, value }) => ({ key, value: value ?? null })),
      notes: (ctx.block.comments || []).slice(-20).map((comment) => comment.text),
      ...extra,
    },
    null,
    2
  );
}

function artifactInstructions(definition) {
  const available = definition.artifacts.filter(({ key }) => key !== 'response');
  return (
    'End your response with a flow-result fenced JSON object when you publish declared artifacts or report a failure. Use values and files as maps keyed by the declared artifact names. File paths must be inside the saved issue checkout. For missing required inputs or proof, include a failure string naming what is missing. Include only actual results. Declared artifacts: ' +
    JSON.stringify(available)
  );
}

function retainModelFile(workspace, folder, { key, label }, file) {
  const original = realpathSync(resolve(workspace.checkout, file));
  requireThat(
    original.startsWith(workspace.checkout + sep) &&
      !relative(workspace.checkout, original).split(sep).includes('.git'),
    'Choose evidence inside the issue checkout.'
  );
  const stat = statSync(original);
  requireThat(stat.isFile() && stat.size <= 25 * 1024 * 1024, 'Choose a file up to 25 MB.');
  const bytes = readFileSync(original);
  const path = join(folder, 'artifact-' + key + '-' + basename(original).slice(-120));
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, label, sha256: digest(bytes) };
}

function modelManifest(output) {
  const manifest = output.match(/```flow-result\s*\n([\s\S]*?)\n```\s*$/i)?.[1];
  return manifest ? JSON.parse(manifest) : {};
}

function modelArtifacts(definition, output, workspace, response) {
  const recorded = modelManifest(output);
  const files = {};
  const values = {};
  for (const artifact of definition.artifacts) {
    const { key, kind, label } = artifact;
    if (kind === 'value' && Object.hasOwn(recorded?.values ?? {}, key)) values[key] = recorded.values[key];
    if (kind !== 'file') continue;
    if (key === 'response') files[key] = response;
    const file = recorded?.files?.[key];
    if (key === 'response' || typeof file !== 'string') continue;
    try {
      files[key] = retainModelFile(workspace, dirname(response.path), artifact, file);
    } catch (error) {
      throw Error('Could not retain ' + label + ': ' + error.message);
    }
  }
  const failure = typeof recorded?.failure === 'string' && recorded.failure.trim();
  return {
    artifacts: { values, files },
    evidence: [response, ...Object.values(files).filter((item) => item !== response)],
    ...(failure ? { status: 'blocked', summary: failure.slice(0, 1200) } : {}),
  };
}

function commandArtifacts(definition, result) {
  const values = {};
  const files = {};
  for (const { key, kind, label } of definition?.artifacts ?? []) {
    if (kind === 'file') {
      const evidence = result.evidence?.find((item) => item.key === key);
      if (evidence) files[key] = { ...evidence, label };
    }
    if (kind === 'value' && key === 'candidate' && result.result?.head) values[key] = result.result.head;
  }
  return { values, files };
}

async function runMergeRepair(service, ctx, owned, options, error, round) {
  try {
    return await runModel(service, { ...ctx, continuing: ctx.continuing || round > 1 }, owned, {
      ...options,
      repair: { error, round },
    });
  } finally {
    owned.connection?.close();
    owned.connection = null;
  }
}

async function runBranchConflictRepair(service, ctx, owned, options, paths, target) {
  const task =
    'Resolve only these conflicted paths and stage the resolution: ' +
    JSON.stringify(paths) +
    '. Leave tests to Verify. Preserve both sides of the merge with ' +
    target +
    '. If preserving both sides needs a product decision, return a flow-result failure with the decision. ' +
    'You have one attempt. Leave HEAD and the merge in place and let Factory commit. ' +
    'Do not edit other paths, commit, abort, reset, switch branches, push, or publish.';
  const context = {
    ...ctx,
    block: { ...ctx.block, prompt: '', skill: null },
    definition: { ...ctx.definition, prompt: task, artifacts: ctx.definition?.artifacts ?? [] },
  };
  return runModel(service, context, owned, { ...options, branchConflictTask: task });
}

async function reconcileMergeRepair(service, ctx, workspace, options) {
  const interrupted = ctx.block.attempts?.some(
    (attempt) =>
      attempt.id !== ctx.attempt.id &&
      !attempt.reconciledAt &&
      ['running', 'stopping', 'uncertain'].includes(attempt.status)
  );
  if (!interrupted) return;
  const saved = conversationState(service.root, ctx.issue.id).flowBlocks?.[ctx.block.id];
  if (!saved) return;
  requireThat(saved.threadId, 'Recover the original merge repair conversation before retrying.');
  const connection = options.create({ onEvent() {} });
  try {
    await options.attach(connection, workspace.checkout, saved, () => {}, 'read-only');
    ctx.signal.throwIfAborted();
    await ctx.onReconciled?.('The original merge repair conversation is idle.');
  } finally {
    connection.close();
  }
}

function modelCommandProgress(ctx) {
  const commands = new Map();
  let phase;
  return {
    begin(step) {
      commands.clear();
      phase = step;
      ctx.onProgress(step, true);
    },
    event(method, item) {
      if (method === 'item/started' && item?.type === 'commandExecution' && item.command) {
        commands.set(item.id, item.command);
        ctx.onStep(item.command);
      }
      if (method === 'item/completed' && commands.delete(item?.id)) {
        const current = [...commands.values()].at(-1) || phase;
        if (current) ctx.onStep(current);
      }
    },
    inputRequired() {
      ctx.onInputRequired?.();
    },
  };
}

function modelPrompt(ctx, options) {
  if (options.branchConflictTask) return options.branchConflictTask;
  if (options.workBase)
    return blockInput(ctx, {
      workComparisonBase: options.workBase,
      destinationRevision: options.destinationRevision,
      formatAndAuditCommand: [
        'node',
        workVerificationScript,
        '--work-checks',
        '--write-format',
        '--base',
        options.workBase,
      ],
    });
  if (!options.repair) return blockInput(ctx);
  return JSON.stringify({
    issue: blockInput(ctx),
    task: [
      'Diagnose and fix the blocker using the saved evidence. Merge authorizes the smallest repairs needed for its required checks, including repairs outside the original feature when they address an inherited failure.',
      'Reproduce and repair inherited test failures, formatting failures, and new Fallow findings that block delivery. Preserve the behavior and coverage the checks protect. Use focused checks to confirm the repair.',
      'Preserve the issue and target history. Commit the repaired candidate in this checkout. Factory will run the full verification and publish the checked candidate.',
      'If a product decision, unrelated change, or permission is required, stop and end your response with a flow-result fenced JSON object containing a failure string that names the blocker.',
    ].join('\n'),
    failure: options.repair.error.message,
    evidence: options.repair.error.evidence ?? [],
  });
}

function workScope(ctx, workspace) {
  const { remote, branch } = deliveryTarget(ctx.flow);
  if (!remote || !branch) return { workBase: workspace.base };
  let destinationRevision;
  try {
    destinationRevision = git(workspace.checkout, 'rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`);
  } catch (error) {
    if (error.status !== 128) throw error;
    return { workBase: workspace.base };
  }
  return { workBase: git(workspace.checkout, 'merge-base', 'HEAD', destinationRevision), destinationRevision };
}

async function checkWorkResponse(ctx, options, workspace, folder, round, output, prompt) {
  if (ctx.block.kind !== 'work') return {};
  const manifest = modelManifest(output);
  if (typeof manifest?.failure === 'string' && manifest.failure.trim()) return {};
  try {
    return {
      workCheck: await options.verifyWork(ctx, workspace, join(folder, `work-checks-${round}`)),
    };
  } catch (error) {
    if (ctx.signal.aborted || !error.verificationFailure || round > maxWorkRepairs) throw error;
    return {
      repairPrompt: JSON.stringify({
        originalWork: prompt,
        task: 'Fix the Work formatting or Fallow failures in this checkout. Preserve unrelated changes. Run the formatting and audit command before rerunning affected focused tests. Factory will recheck formatting and Fallow.',
        summary: error.message,
        evidence: (error.evidence ?? []).map(({ path }) => path),
      }),
      failedChecks: error.evidence ?? [],
    };
  }
}

function retainWorkCandidate(definition, retained, workCheck, head) {
  if (workCheck && definition.artifacts?.some(({ key, kind }) => key === 'candidate' && kind === 'value'))
    retained.artifacts.values.candidate = head;
}

function workingTree(workspace) {
  const status = git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all');
  const index = mkdtempSync(join(tmpdir(), 'timey-flow-index-'));
  const indexPath = join(index, 'index');
  const run = (...args) =>
    execFileSync('git', ['-C', workspace.checkout, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: indexPath },
      stdio: 'pipe',
    }).trim();
  try {
    run('read-tree', 'HEAD');
    run('add', '-A');
    return { tree: run('write-tree'), uncommitted: Boolean(status) };
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

function retainCandidateIdentity(definition, retained, workspace, head) {
  const candidate = workingTree(workspace);
  const values = {
    candidateBase: workspace.base,
    candidateTree: candidate.tree,
    candidateCommit: head,
    candidateUncommitted: candidate.uncommitted,
  };
  for (const [key, value] of Object.entries(values))
    if (definition.artifacts?.some((artifact) => artifact.key === key)) retained.artifacts.values[key] = value;
  return candidate;
}

async function runModel(service, ctx, owned, options) {
  requireThat(
    ctx.block.kind !== 'prototype' || ctx.block.prompt?.trim(),
    'Describe the prototype to create or run before starting this block.'
  );
  requireThat(
    ctx.block.kind !== 'edit' || ctx.block.edits?.some((edit) => edit.enabled),
    'Enable at least one edit before starting this block.'
  );
  requireThat(
    !service.sharedIssues || service.sharedIssues.view(ctx.issue.id).local,
    'Acquire this shared issue through its protected claim operation before running a block.'
  );
  const workspace = await workspaceFor(service, ctx);
  const sandbox = readOnlyBlocks.has(ctx.block.kind) ? 'read-only' : 'workspace-write';
  if (sandbox === 'workspace-write') guardBlock(service, ctx, 'implement', workspace.base);
  const state = conversationState(service.root, ctx.issue.id);
  const savedBlock = state.flowBlocks?.[ctx.block.id];
  requireThat(
    !savedBlock?.startup || savedBlock.startup.status === 'ready',
    'Chat startup is uncertain. Reconcile the original connection before continuing.'
  );
  const basis = digest(
    JSON.stringify([
      ctx.attempt.definitionChecksum,
      ctx.attempt.details,
      ctx.block.skill,
      ctx.block.prompt,
      ctx.block.comments,
    ])
  );
  const previous = ctx.block.attempts?.findLast(
    (attempt) =>
      attempt.id !== ctx.attempt.id &&
      !attempt.reconciledAt &&
      ['running', 'stopping', 'uncertain'].includes(attempt.status)
  );
  const recover =
    previous &&
    (savedBlock?.threadId
      ? savedBlock
      : { threadId: state.threadId || service.lifecycleRuns[ctx.issue.id]?.workThreadId });
  const last = ctx.block.attempts?.findLast((attempt) => attempt.id !== ctx.attempt.id);
  const binding = ctx.continuing && !last?.invalidatedAt && savedBlock?.basis === basis ? { ...savedBlock } : { basis };
  service.issueChats?.release(ctx.issue.id);
  const folder = evidenceDirectory(service, ctx);
  const outputPath = join(folder, options.repair ? 'repair-' + options.repair.round + '.txt' : 'output.txt');
  let liveText = '';
  const progress = modelCommandProgress(ctx);
  let rejectInput;
  const inputRequired = new Promise((_, reject) => {
    rejectInput = reject;
  });
  inputRequired.catch(() => {});
  const connection = options.create({
    onEvent(message) {
      const params = message.params || {};
      if (message.method === 'item/agentMessage/delta') {
        liveText = (liveText + redactValue(String(params.delta || ''))).slice(-32000);
        writeFileSync(outputPath, liveText, { mode: 0o600 });
      }
      if (params.delta) ctx.onProgress(params.delta);
      else if (message.method === 'item/started')
        ctx.onProgress(params.item?.command || params.item?.type || 'Working');
      progress.event(message.method, params.item);
      if (message.method === 'ui/approval' || message.method === 'ui/unsupportedRequest') {
        progress.inputRequired();
        const error = Error(
          'This block needs provider permission or human input. Its saved request requires attention before continuation.'
        );
        error.input = redactValue(params);
        rejectInput(error);
      }
      service.store?.event?.(message);
    },
  });
  owned.connection = connection;
  const skills = selectedSkills(
    await listAvailableSkills(connection, workspace.checkout),
    ctx.block.skill ? [ctx.block.skill] : []
  );
  const settings = newChatModelSettings(service.root, ctx.issue.id);
  let rounds = 1;
  if (ctx.block.kind === 'sol') {
    rounds = ctx.block.iterations;
    requireThat(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'Choose between one and ten Sol iterations.');
    const available = await connection.call('model/list', { limit: 100 });
    const model = (available.data || []).find((item) => /\bsol\b/i.test(`${item.id} ${item.displayName || ''}`));
    requireThat(
      model,
      'No Sol model is available. Install or enable a Sol model before running this block. No substitute was used.'
    );
    settings.model = model.id;
  }
  const retain = (changes) => {
    Object.assign(binding, changes);
    state.flowBlocks = { ...state.flowBlocks, [ctx.block.id]: binding };
    saveConversationState(service.root, ctx.issue.id, state);
  };
  const scope = ctx.block.kind === 'work' ? workScope(ctx, workspace) : {};
  const prompt = modelPrompt(ctx, { ...options, ...scope });
  const instructions = [
    ctx.definition.prompt,
    ctx.block.skill ? '' : ctx.block.prompt,
    'Use only the supplied Details, instructions, and notes as inputs from this flow.',
    artifactInstructions(ctx.definition),
  ]
    .filter(Boolean)
    .join('\n\n');
  const outputs = [];
  const failedChecks = [];
  let workCheck;
  let repairPrompt;
  let threadId;
  let turnDispatched = false;
  let terminalObserved = false;
  let rejectStopped;
  let interruptTimer;
  let finished = false;
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => {});
  const stopError = () =>
    Object.assign(Error('The block was stopped. Reconcile its original provider turn before retrying.'), {
      name: 'AbortError',
      uncertain: true,
    });
  const interrupt = () => {
    if (terminalObserved) return;
    if (!threadId) {
      connection.close();
      rejectStopped(stopError());
      return;
    }
    Promise.resolve(connection.interrupt(threadId)).then(
      () => {
        if (!finished) interruptTimer = setTimeout(() => rejectStopped(stopError()), 10000);
      },
      (error) => {
        ctx.onProgress('Interruption is uncertain. ' + error.message);
        rejectStopped(stopError());
      }
    );
  };
  ctx.signal.addEventListener('abort', interrupt, { once: true });
  try {
    ctx.signal.throwIfAborted();
    requireThat(
      !previous || recover?.threadId,
      'Recover the original Codex conversation before continuing this block.'
    );
    if (recover?.threadId && recover.threadId !== binding.threadId) {
      await Promise.race([stopped, options.attach(connection, workspace.checkout, recover, () => {}, sandbox)]);
      ctx.signal.throwIfAborted();
    }
    threadId = await Promise.race([
      stopped,
      options.attach(connection, workspace.checkout, binding, retain, sandbox, instructions),
    ]);
    ctx.signal.throwIfAborted();
    await ctx.onReconciled?.();
    retain({
      threadId,
      status: 'responding',
      messageId: ctx.attempt.id,
      skill: ctx.block.skill || null,
    });
    appendMessage(service.root, ctx.issue.id, {
      id: 'flow-request-' + ctx.attempt.id + (options.repair ? '-repair-' + options.repair.round : ''),
      actor: 'human',
      role: 'You',
      kind: 'flow-block-request',
      body: prompt,
      blockId: ctx.block.id,
    });
    for (let round = 1; round <= rounds; round++) {
      ctx.signal.throwIfAborted();
      progress.begin(
        repairPrompt
          ? `Repairing Work after verification failed (attempt ${round - 1} of ${maxWorkRepairs}).\n`
          : ctx.block.kind === 'sol'
            ? `Sol iteration ${round}/${rounds}.`
            : `Running ${ctx.block.kind} block.`
      );
      turnDispatched = true;
      terminalObserved = false;
      const text = await Promise.race([
        stopped,
        inputRequired,
        connection.turn(
          threadId,
          workspace.checkout,
          repairPrompt ??
            (round === 1
              ? prompt
              : `${prompt}\n\nIteration ${round}/${rounds}. Recheck the previous findings against the current candidate.`),
          undefined,
          skillInputs(skills),
          settings,
          {
            clientId: options.repair
              ? `${ctx.attempt.id}-repair-${options.repair.round}`
              : `${ctx.attempt.id}-${round}`,
            accepted(receipt) {
              retain({
                flowReceipt: { ...receipt, attemptId: ctx.attempt.id, round },
              });
            },
          }
        ),
      ]);
      terminalObserved = true;
      ctx.signal.throwIfAborted();
      requireThat(typeof text === 'string' && text.trim(), 'The block returned no result. Reconcile its saved turn.');
      outputs.push(redactValue(text));
      writeFileSync(outputPath, outputs.join('\n\n'), { mode: 0o600 });
      const check = await checkWorkResponse(
        ctx,
        options,
        { ...workspace, base: scope.workBase },
        folder,
        round,
        outputs.at(-1),
        prompt
      );
      ({ workCheck, repairPrompt } = check);
      if (repairPrompt) {
        failedChecks.push(...check.failedChecks);
        rounds++;
      }
    }
    const output = outputs.join('\n\n');
    appendMessage(service.root, ctx.issue.id, {
      id: 'flow-result-' + ctx.attempt.id + (options.repair ? '-repair-' + options.repair.round : ''),
      actor: 'agent',
      role: 'Issue assistant',
      kind: 'flow-block-result',
      body: output,
      blockId: ctx.block.id,
    });
    retain({ status: 'idle' });
    const response = { path: outputPath, label: 'Block response', sha256: digest(readFileSync(outputPath)) };
    const retained = modelArtifacts(ctx.definition, outputs.at(-1), workspace, response);
    const head = git(workspace.checkout, 'rev-parse', 'HEAD');
    const candidate = retainCandidateIdentity(ctx.definition, retained, workspace, head);
    retainWorkCandidate(ctx.definition, retained, workCheck, head);
    return {
      summary: outputs.at(-1).slice(0, 1200),
      output,
      ...retained,
      evidence: [...retained.evidence, ...failedChecks, ...(workCheck?.evidence ?? [])],
      result: {
        threadId,
        skill: ctx.block.skill || null,
        iterations: rounds,
        head,
        tree: candidate.tree,
        base: workspace.base,
        commit: head,
        uncommitted: candidate.uncommitted,
      },
      workspace,
    };
  } catch (error) {
    if (turnDispatched && !terminalObserved && !['failed', 'interrupted', 'completed'].includes(error.terminalStatus))
      error.uncertain = true;
    if (error.input) {
      const requestPath = join(folder, 'input-required.json');
      writeJson(requestPath, error.input);
      error.uncertain = true;
      await connection
        .interrupt(threadId)
        .catch((failure) => ctx.onProgress('Interruption is uncertain. ' + failure.message));
      error.evidence = [{ path: requestPath, label: 'Provider input required' }];
    }
    const partial = redactValue(error.partialText || outputs.join('\n\n') || liveText);
    if (partial) writeFileSync(outputPath, partial, { mode: 0o600 });
    retain({
      status:
        ['interrupted', 'completed', 'failed'].includes(error.terminalStatus) || terminalObserved
          ? 'idle'
          : 'attention',
    });
    error.evidence = [
      ...failedChecks,
      ...(error.evidence || []),
      ...(partial ? [{ path: outputPath, label: 'Partial block response' }] : []),
    ];
    throw error;
  } finally {
    finished = true;
    clearTimeout(interruptTimer);
    ctx.signal.removeEventListener('abort', interrupt);
  }
}

async function runReconciledCommand(service, ctx, options) {
  const result = await runCommand(service, ctx, options);
  await ctx.onReconciled?.('The explicit command retry completed and returned its current Git or PR result.');
  return result;
}

async function runCommand(service, ctx, options) {
  ctx.signal.throwIfAborted();
  const kind = ctx.block.kind;
  const record = service.lifecycleRuns[ctx.issue.id];
  const work = record?.work;
  if (kind === 'retro') {
    const result = await (options.runRetro || runRetro)(service, ctx);
    return commandResult(service, ctx, result, result.summary);
  }
  if (kind === 'cleanup') {
    const saved = work || record?.chatCheckout || ctx.flow.workspace;
    const workspace = saved && { ...saved };
    if (workspace && !workspace.config) {
      try {
        workspace.config = await flowCleanupConfig(service, ctx, workspace, options);
      } catch {
        const { branch: target, remote } = deliveryTarget(ctx.flow);
        workspace.config = { target, remote };
      }
    }
    const cleanupService = workspace ? worktreeCleanupService(service, ctx.issue.id, workspace) : service;
    const previous = issueCleanupRecord(service.root, ctx.issue.id);
    const result =
      !ctx.input.freshCleanup && previous?.status === 'incomplete' && previous.closure?.at === ctx.issue.closure?.at
        ? (await retryIssueCleanup(cleanupService, ctx.issue.id, previous, ctx.input.resourceId)).cleanup
        : await runFlowCleanup(cleanupService, ctx.issue.id, ctx.flow.closing.resolution, ctx.flow.closing.branches);
    const complete = result.status === 'complete';
    return {
      ...commandResult(service, ctx, result, complete ? 'Cleanup complete.' : 'Cleanup needs attention.'),
      status: complete ? 'completed' : 'blocked',
    };
  }
  if (['close', 'delete-worktree'].includes(kind))
    requireThat(
      ctx.input?.confirmed === true,
      'Confirm this protected lifecycle operation explicitly before running the block.'
    );
  if (kind === 'publish') {
    const workspace = await workspaceFor(service, ctx);
    const published = await publishFlowPR(service, ctx, workspace, evidenceDirectory(service, ctx), options);
    return {
      ...commandResult(service, ctx, published.result, published.summary, published.evidence),
      workspace: published.workspace,
      ...(published.status ? { status: published.status } : {}),
    };
  }
  if (kind === 'merge') {
    requireThat(
      work?.checkout || record?.chatCheckout?.checkout || ctx.flow.workspace?.checkout,
      'No protected PR candidate or managed issue checkout is recorded. Run an explicit work block first.'
    );
    const workspace = await workspaceFor(service, ctx);
    await reconcileMergeRepair(service, ctx, workspace, options);
    const outcome = await mergeFlowPR(service, ctx, workspace, evidenceDirectory(service, ctx), options);
    return { ...outcome, ...commandResult(service, ctx, outcome.result, outcome.summary, outcome.evidence) };
  }
  if (kind === 'close') {
    const queue = readQueue(service.root);
    const issue = queue.issues.find((item) => item.id === ctx.issue.id);
    requireThat(issue, 'This issue is no longer open. Refresh its saved closure.');
    const artifact = usesLegacyDelivery(service, ctx)
      ? null
      : await flowClosureArtifact(
          service,
          ctx,
          await workspaceFor(service, ctx),
          evidenceDirectory(service, ctx),
          options
        );
    const result = await (options.closeIssue || decideIssue)(
      service,
      issue.id,
      issue.state,
      'close',
      decisionBasis(queue, issue),
      ctx.block.prompt || '',
      'fixed',
      null,
      artifact
    );
    await service.issueCleanupTasks?.get(issue.id);
    return commandResult(service, ctx, result, 'The protected acceptance and closure operation finished.');
  }
  if (kind === 'delete-worktree') {
    const workspace = record?.work || record?.chatCheckout || ctx.flow.workspace;
    requireThat(workspace?.checkout, 'No managed checkout is recorded for this issue.');
    const cleanupService = worktreeCleanupService(service, ctx.issue.id, workspace);
    const remove = options.deleteWorktree || deleteIssueWorktree;
    const expected = await remove(cleanupService, { issueId: ctx.issue.id });
    ctx.signal.throwIfAborted();
    const result = await remove(cleanupService, {
      issueId: ctx.issue.id,
      expected,
    });
    return commandResult(service, ctx, result, 'The protected worktree deletion finished.');
  }
  const workspace = await workspaceFor(service, ctx);
  const folder = evidenceDirectory(service, ctx);
  const log = join(folder, 'command.log');
  const operation = kind === 'verify' ? 'verify' : 'implement';
  guardBlock(service, ctx, operation, workspace.base);
  const invoke = (command, args) =>
    options.execute({
      command,
      args,
      cwd: workspace.checkout,
      log,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
  if (kind === 'verify') {
    const { result, evidence } = await options.verifyCandidate(ctx, workspace, folder);
    const summary = result.uncommitted
      ? 'Verification passed for the uncommitted source snapshot.'
      : 'Explicit verification passed.';
    return { ...commandResult(service, ctx, result, summary, evidence), workspace };
  }
  await reconcileMergeRepair(service, ctx, workspace, options);
  const upstream = await startingBranchUpstream(ctx.flow, (...args) => git(workspace.checkout, ...args));
  const update = await updateIssueBranch(workspace, upstream, invoke, options.resolveBranchConflicts, ctx.signal);
  const { target, head, updated, message, evidence } = update;
  const branchSummary = updated
    ? 'Updated the issue branch from the starting branch.'
    : 'The issue branch already contains the fetched starting branch.';
  const messagePath = join(folder, 'merge-message.txt');
  writeFileSync(messagePath, message + '\n', { mode: 0o600 });
  return {
    ...commandResult(
      service,
      ctx,
      { upstream: upstream.remote + '/' + upstream.branch, fetchedCommit: target, head, containsFetchedCommit: true },
      branchSummary,
      [
        { key: 'mergeMessage', path: messagePath, label: 'Merge message', sha256: digest(readFileSync(messagePath)) },
        { key: 'log', path: log, label: 'Branch fetch and merge output' },
        ...evidence,
      ]
    ),
    workspace,
  };
}

async function flowCleanupConfig(service, ctx, workspace, options) {
  const { flowDeliveryProvider } = await import('./flow-delivery.mjs');
  return flowDeliveryProvider(service, ctx, workspace, options).config;
}

function usesLegacyDelivery(service, ctx) {
  const work = service.lifecycleRuns[ctx.issue.id]?.work;
  return (
    work &&
    deliveryTarget(ctx.flow).branch === (work.config?.target ?? ctx.flow.target?.branch) &&
    !upstreamBlocks(ctx.block, ctx.flow.blocks).some((block) => block.attempts.some((attempt) => attempt.invalidatedAt))
  );
}

function commandResult(service, ctx, result, summary, evidence = []) {
  const path = join(evidenceDirectory(service, ctx), 'result.json');
  writeJson(path, result);
  return {
    summary,
    result,
    evidence: [
      ...evidence,
      { key: 'result', path, label: 'Recorded operation result', sha256: digest(readFileSync(path)) },
    ],
  };
}

function executeCommand({ command, args, cwd, log, signal, onProgress }) {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cleanEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    const collect = (data) => {
      const text = redactValue(String(data));
      output += text;
      appendFileSync(log, text, { mode: 0o600 });
      onProgress(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code, termination) => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted)
        reject(
          Object.assign(
            Error('The block command was interrupted. Inspect the retained checkout and output before retrying.'),
            {
              name: 'AbortError',
              evidence: [{ path: log, label: 'Interrupted command output' }],
            }
          )
        );
      else if (code === 0) resolveResult(output);
      else
        reject(
          Object.assign(Error(`The block command failed (${termination || code}). Inspect ${log}.`), {
            exitCode: code,
            commandOutput: output,
            evidence: [{ path: log, label: 'Failed command output' }],
          })
        );
    });
  });
}
