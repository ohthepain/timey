import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createIssueChatConnection, attachIssueChat } from './issue-chat-runtime.mjs';
import { conversationState, saveConversationState, appendMessage } from './conversation-store.mjs';
import { listAvailableSkills, selectedSkills, skillInputs } from './skills.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { mergeIssueStrategyPR } from './issue-strategy.mjs';
import { deleteIssueWorktree, issueHasActiveWork } from './issue-cleanup.mjs';
import { decideIssue } from './issue-decision.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { readQueue } from './data.mjs';
import { git, cleanEnvironment, requireThat, writeJson, digest } from './common.mjs';
import { redactValue } from './activity.mjs';
import { flowClosureArtifact, flowDeliveryProvider, publishFlowPR, verifiedFlowCandidate } from './flow-delivery.mjs';

const modelBlocks = new Map([
  [
    'request',
    'Refine the request into its goal, pass/fail done check, requested proof, known facts and constraints. Preserve the user intent.',
  ],
  ['refine', 'Refine the request. Preserve the user intent and separate facts from assumptions.'],
  ['sharpen', 'Establish shared understanding and sharpen the requested outcome.'],
  ['understand', 'Explain the requested subsystem using observed evidence.'],
  ['design', 'Design the requested change and record decisions and unresolved choices.'],
  ['work', 'Perform only the requested work.'],
  ['repro', 'Reproduce the reported behavior and retain the observed result. Do not fix it.'],
  ['tdd', 'Create the requested failing test to drive implementation. Do not implement the fix.'],
  ['benchmark', 'Check the measurement method and retain actual command output and its limits.'],
  ['prototype', 'Create or run only the prototype explicitly described by the user.'],
  ['edit', 'Apply only the enabled edits listed below.'],
  [
    'retro',
    'Review this issue and recommend concrete next actions. Do not create issues or perform the recommendations.',
  ],
  ['advice', 'Recommend skills and routing for this request. Do not execute the recommendations.'],
  ['playbook', 'Produce a proposed playbook for this request. Do not execute its steps.'],
  [
    'sol',
    'Review the current issue candidate. Report findings with evidence. Do not edit code or start nested reviewers.',
  ],
]);
const readOnlyBlocks = new Set(['request', 'refine', 'sharpen', 'understand', 'retro', 'advice', 'playbook', 'sol']);
const commandBlocks = new Set(['verify', 'merge-target', 'publish', 'merge', 'close', 'delete-worktree']);

export function createFlowExecutor(service, options = {}) {
  const active = new Map();
  let closed = false;
  const create = options.createConnection || createIssueChatConnection;
  const execute = options.execute || executeCommand;
  const attach = options.attach || attachIssueChat;
  return {
    async run(ctx) {
      requireThat(!closed, 'The block executor is closed. Restart the server before running another block.');
      requireThat(
        !active.has(ctx.issue.id),
        'A block for this issue is already running. Stop it before starting another.'
      );
      const scopedService = operationService(service, ctx.issue.id);
      assertIdle(scopedService, ctx.issue.id);
      requireThat(modelBlocks.has(ctx.block.kind) || commandBlocks.has(ctx.block.kind), 'Choose a supported block.');
      const controller = new AbortController();
      const forward = () => controller.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener('abort', forward, { once: true });
      if (ctx.signal?.aborted) forward();
      const owned = { controller, connection: null };
      active.set(ctx.issue.id, owned);
      const bounded = (text) => ctx.onProgress?.(redactValue(String(text)).slice(-2000));
      const context = {
        ...ctx,
        signal: controller.signal,
        onProgress: bounded,
      };
      try {
        context.signal.throwIfAborted();
        service.ownServer();
        return modelBlocks.has(ctx.block.kind)
          ? await runModel(service, context, owned, {
              create,
              attach,
              ...options,
            })
          : await runReconciledCommand(scopedService, context, { execute, ...options });
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

async function workspaceFor(service, ctx) {
  const record = service.lifecycleRuns[ctx.issue.id] || {
    id: randomUUID(),
    issueId: ctx.issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  const saved = record.work || record.chatCheckout || ctx.flow.workspace;
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
    workspace.branch && workspace.branch !== ctx.flow.target.branch,
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
  if (!record.work) saveLifecycle(service, record, { chatCheckout: { ...workspace } });
  await ctx.onWorkspace?.(workspace);
  return workspace;
}

function startingRevision(root, flow) {
  if (flow.startingPoint) {
    const commit = flow.startingPoint.commit;
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

function blockPrompt(ctx) {
  const enabled = (ctx.block.edits || []).filter((edit) => edit.enabled).map((edit) => edit.text);
  return [
    `You are executing exactly one explicit ${ctx.block.kind} block for issue ${ctx.issue.id}.`,
    modelBlocks.get(ctx.block.kind),
    'Stop when this block is complete. Do not continue to another block, run aggregate verification, publish, push, merge, close, delete worktrees, or perform cleanup. Verification and lifecycle operations require their own explicit blocks. A selected skill supplies method only; instructions to automatically execute later stages are outside this block.',
    'Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.',
    `Issue type: ${ctx.flow.type}. Request: ${JSON.stringify(ctx.flow.request)}.`,
    `Target: ${JSON.stringify(ctx.flow.target)}.`,
    `Issue report:\n${ctx.issue.content || ctx.issue.title || ''}`,
    `User notes for this block:\n${(ctx.block.comments || [])
      .slice(-20)
      .map((comment) => comment.text)
      .join('\n\n')}`,
    `User instruction for this block:\n${ctx.block.prompt || ''}`,
    ...(ctx.block.kind === 'edit' ? [`Enabled edits:\n${enabled.map((edit) => '- ' + edit).join('\n')}`] : []),
    ...(ctx.block.attempts?.length > 1
      ? [
          'Continue this same block with its selected skill and the saved conversation. Retain earlier findings and failed attempts.',
        ]
      : []),
  ].join('\n\n');
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
  const workThreadId = service.lifecycleRuns[ctx.issue.id]?.workThreadId;
  requireThat(
    !state.threadId || !workThreadId || state.threadId === workThreadId,
    'The saved issue conversation and legacy worker chat differ. Reconcile their identities before continuing.'
  );
  if (workThreadId) state.threadId = workThreadId;
  service.issueChats?.release(ctx.issue.id);
  const folder = evidenceDirectory(service, ctx);
  const outputPath = join(folder, 'output.txt');
  let liveText = '';
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
      if (message.method === 'ui/approval' || message.method === 'ui/unsupportedRequest') {
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
  const previous = state.flowBlocks?.[ctx.block.id];
  requireThat(
    !previous || previous.skill === (ctx.block.skill || null),
    'Continue this block with its saved skill, or add a new block for a different method.'
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
    Object.assign(state, changes);
    saveConversationState(service.root, ctx.issue.id, state);
  };
  const prompt = blockPrompt(ctx);
  const outputs = [];
  let threadId;
  let turnDispatched = false;
  let terminalObserved = false;
  let rejectStopped;
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
    if (!threadId) {
      connection.close();
      rejectStopped(stopError());
      return;
    }
    Promise.resolve(connection.interrupt(threadId)).then(
      () => setTimeout(() => rejectStopped(stopError()), 0),
      (error) => {
        ctx.onProgress('Interruption is uncertain. ' + error.message);
        rejectStopped(stopError());
      }
    );
  };
  ctx.signal.addEventListener('abort', interrupt, { once: true });
  try {
    ctx.signal.throwIfAborted();
    threadId = await Promise.race([stopped, options.attach(connection, workspace.checkout, state, retain, sandbox)]);
    ctx.signal.throwIfAborted();
    await ctx.onReconciled?.();
    retain({
      threadId,
      status: 'responding',
      messageId: ctx.attempt.id,
      flowBlocks: {
        ...state.flowBlocks,
        [ctx.block.id]: { skill: ctx.block.skill || null },
      },
    });
    appendMessage(service.root, ctx.issue.id, {
      id: 'flow-request-' + ctx.attempt.id,
      actor: 'human',
      role: 'You',
      kind: 'flow-block-request',
      body: prompt,
      blockId: ctx.block.id,
    });
    for (let round = 1; round <= rounds; round++) {
      ctx.signal.throwIfAborted();
      ctx.onProgress(rounds > 1 ? `Sol iteration ${round}/${rounds}.` : `Running ${ctx.block.kind} block.`);
      turnDispatched = true;
      terminalObserved = false;
      const text = await Promise.race([
        stopped,
        inputRequired,
        connection.turn(
          threadId,
          workspace.checkout,
          round === 1
            ? prompt
            : `${prompt}\n\nIteration ${round}/${rounds}. Recheck the previous findings against the current candidate.`,
          undefined,
          skillInputs(skills),
          settings,
          {
            clientId: `${ctx.attempt.id}-${round}`,
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
    }
    const output = outputs.join('\n\n');
    appendMessage(service.root, ctx.issue.id, {
      id: 'flow-result-' + ctx.attempt.id,
      actor: 'agent',
      role: 'Issue assistant',
      kind: 'flow-block-result',
      body: output,
      blockId: ctx.block.id,
    });
    retain({ status: 'idle' });
    return {
      summary: output.slice(0, 1200),
      output,
      evidence: [{ path: outputPath, label: 'Block response', sha256: digest(readFileSync(outputPath)) }],
      result: {
        threadId,
        skill: ctx.block.skill || null,
        iterations: rounds,
        head: git(workspace.checkout, 'rev-parse', 'HEAD'),
        tree: git(workspace.checkout, 'rev-parse', 'HEAD^{tree}'),
        base: workspace.base,
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
      status: error.terminalStatus === 'interrupted' ? 'idle' : 'attention',
    });
    error.evidence = [
      ...(error.evidence || []),
      ...(partial ? [{ path: outputPath, label: 'Partial block response' }] : []),
    ];
    throw error;
  } finally {
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
  if (['publish', 'merge', 'close', 'delete-worktree'].includes(kind))
    requireThat(
      ctx.input?.confirmed === true,
      'Confirm this protected lifecycle operation explicitly before running the block.'
    );
  if (kind === 'publish') {
    const workspace = await workspaceFor(service, ctx);
    const published = await publishFlowPR(service, ctx, workspace, evidenceDirectory(service, ctx), options);
    return {
      ...commandResult(
        service,
        ctx,
        published.result,
        'Published the verified issue branch and App-authored PR. Merge and acceptance remain separate.',
        published.evidence
      ),
      workspace: published.workspace,
    };
  }
  if (kind === 'merge') {
    const work = record?.work;
    if (!work?.pr || !work.prHead || !work.runId) return mergeFlowPR(service, ctx, options);
    const result = await (options.merge || mergeIssueStrategyPR)(service, {
      issueId: ctx.issue.id,
      pr: work.pr,
      head: work.prHead,
      runId: work.runId,
    });
    return commandResult(service, ctx, result, 'The protected merge operation finished.');
  }
  if (kind === 'close') {
    const queue = readQueue(service.root);
    const issue = queue.issues.find((item) => item.id === ctx.issue.id);
    requireThat(issue, 'This issue is no longer open. Refresh its saved closure.');
    const artifact = record?.work
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
    requireThat(
      record?.work?.checkout || record?.chatCheckout?.checkout,
      'No managed checkout is recorded for this issue.'
    );
    const cleanupService = Object.create(service);
    cleanupService.lifecycleRuns = Object.fromEntries(
      Object.entries(service.lifecycleRuns).map(([id, saved]) => [
        id,
        saved.work || !saved.chatCheckout ? saved : { ...saved, work: saved.chatCheckout },
      ])
    );
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
    const script = `import {checkCandidate} from ${JSON.stringify(new URL('./checks.mjs', import.meta.url).href)}; const result = await checkCandidate(${JSON.stringify(workspace.checkout)}, ${JSON.stringify(workspace.base)}, ${JSON.stringify(folder)}, {auditPolicy:'required',force:true,allowUncommitted:true,onProgress:text=>process.stdout.write(text)}); console.log(); console.log('FLOW_RESULT '+JSON.stringify(result));`;
    const output = await invoke(process.execPath, ['--input-type=module', '-e', script]);
    const line = output.split(/\r?\n/).findLast((value) => value.startsWith('FLOW_RESULT '));
    requireThat(
      line,
      'The verification command did not return its recorded candidate evidence. Inspect the command log.'
    );
    const result = JSON.parse(line.slice('FLOW_RESULT '.length));
    result.base = workspace.base;
    result.proof = (result.summaries || []).map((path) => ({
      path,
      sha256: digest(readFileSync(path)),
    }));
    result.supportingProof = (result.summaries || [])
      .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')).checks || [])
      .flatMap((check) => [check.log, ...(check.artifacts || []).map((file) => file.path)])
      .map((path) => ({ path, sha256: digest(readFileSync(path)) }));
    return {
      ...commandResult(
        service,
        ctx,
        result,
        result.uncommitted
          ? 'Verification passed for the uncommitted source snapshot.'
          : 'Explicit verification passed.',
        [
          { path: log, label: 'Verification command output' },
          ...(result.summaries || []).map((path) => ({
            path,
            label: 'Verification summary',
          })),
        ]
      ),
      workspace,
    };
  }
  requireThat(
    !git(workspace.checkout, 'status', '--porcelain', '--untracked-files=all'),
    'Preserve checkout changes in a commit before merging the target branch.'
  );
  const { remote, branch } = ctx.flow.target;
  requireThat(
    typeof remote === 'string' && /^[\w.-]+$/.test(remote) && !remote.startsWith('-'),
    'Configure a valid target remote before merging it.'
  );
  git(workspace.checkout, 'check-ref-format', '--branch', branch);
  await invoke('git', ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  ctx.signal.throwIfAborted();
  const target = git(workspace.checkout, 'rev-parse', '--verify', `refs/remotes/${remote}/${branch}`);
  await invoke('git', ['merge', '--no-edit', target]);
  return {
    ...commandResult(
      service,
      ctx,
      {
        target,
        targetRevision: target,
        head: git(workspace.checkout, 'rev-parse', 'HEAD'),
      },
      'Merged the fetched target into the issue branch.',
      [{ path: log, label: 'Target fetch and merge output' }]
    ),
    workspace,
  };
}

async function mergeFlowPR(service, ctx, options) {
  const saved = service.lifecycleRuns[ctx.issue.id]?.chatCheckout || ctx.flow.workspace;
  requireThat(
    saved?.checkout,
    'No protected PR candidate or managed issue checkout is recorded. Run an explicit work block first.'
  );
  const workspace = await workspaceFor(service, ctx);
  const provider = flowDeliveryProvider(service, ctx, workspace, options);
  const pr = await provider.findByBranch(workspace.branch, ctx.flow.target.branch);
  requireThat(
    pr,
    `No PR exists for ${workspace.branch}. Run an explicit Publish block against ${ctx.flow.target.branch}, then explicitly retry this Merge block.`
  );
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  let readiness = await provider.ready(pr, workspace.branch, head);
  if (readiness.merged)
    return {
      ...commandResult(
        service,
        ctx,
        { ...readiness.merge, pr: pr.number, alreadyMerged: true },
        'GitHub confirms this issue PR was merged externally. Acceptance remains separate.'
      ),
      workspace: { ...workspace, pr: pr.number },
    };
  verifiedFlowCandidate(ctx, workspace, options);
  requireThat(
    !service.sharedIssues || !git(workspace.checkout, 'diff', '--name-only', readiness.target, head, '--', '.issues/'),
    'Shared issue reports require their separate human-reviewed queue PR.'
  );
  ctx.signal.throwIfAborted();
  service.guard(
    service.root,
    { id: ctx.attempt.id, issues: [ctx.issue.id], worker_revision: head },
    'merge',
    readiness.target
  );
  await provider.assertApproved(pr.number, head);
  readiness = await provider.ready(await provider.inspect(pr.number), workspace.branch, head);
  if (readiness.merged)
    return {
      ...commandResult(
        service,
        ctx,
        { ...readiness.merge, pr: pr.number, alreadyMerged: true },
        'GitHub confirms this issue PR was merged. Acceptance remains separate.'
      ),
      workspace: { ...workspace, pr: pr.number },
    };
  ctx.signal.throwIfAborted();
  let merge;
  try {
    merge = await provider.merge(pr.number, head);
  } catch (error) {
    const reconciled = await provider.ready(await provider.inspect(pr.number), workspace.branch, head);
    if (!reconciled.merged) throw error;
    merge = reconciled.merge;
  }
  return {
    ...commandResult(
      service,
      ctx,
      { ...merge, pr: pr.number, head },
      'GitHub confirms the protected merge. Acceptance and local target synchronization remain separate.'
    ),
    workspace: { ...workspace, pr: pr.number },
  };
}

function commandResult(service, ctx, result, summary, evidence = []) {
  const path = join(evidenceDirectory(service, ctx), 'result.json');
  writeJson(path, result);
  return {
    summary,
    result,
    evidence: [...evidence, { path, label: 'Recorded operation result', sha256: digest(readFileSync(path)) }],
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
            evidence: [{ path: log, label: 'Failed command output' }],
          })
        );
    });
  });
}
