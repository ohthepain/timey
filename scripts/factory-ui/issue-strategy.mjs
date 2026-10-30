import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readQueue } from './data.mjs';
import { digest, git, readJson, requireThat, writeJson } from './common.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';
import { issueWorkChat } from './issue-work-chat.mjs';
import { appendMessage, conversationState, saveConversationState } from './conversation-store.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { strategyPrompt, strategyResultSchema } from './strategy-prompt.mjs';
import { runSolLoop } from './strategy-review.mjs';

export function strategyBasis(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  return digest(
    JSON.stringify({
      report: issue.content,
      plan: record?.plan,
      work: record?.work,
      config:
        record?.work?.config ||
        (existsSync(join(service.root, '.issues/issue-delivery-config.json'))
          ? readJson(join(service.root, '.issues/issue-delivery-config.json'))
          : null),
    })
  );
}
export function strategyView(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  const config = existsSync(join(service.root, '.issues/issue-delivery-config.json'))
    ? readJson(join(service.root, '.issues/issue-delivery-config.json'))
    : null;
  return {
    target: record?.work?.config?.target || config?.target || null,
    repository: record?.work?.config?.repository || config?.repository || null,
    strategy: record?.work?.strategy || 'full-stop',
    solRounds: record?.work?.solRounds || 0,
    status:
      record?.status === 'running' && !service.lifecycleTasks.has(issue.id) ? 'paused' : record?.status || 'queued',
    summary:
      record?.status === 'running' && !service.lifecycleTasks.has(issue.id)
        ? 'Work was interrupted. Inspect the saved chat before continuing; no automatic retry was started.'
        : record?.summary || '',
    runId: record?.work?.runId,
    pr: record?.work?.pr,
    prUrl: record?.work?.readiness?.url || null,
    checkout: record?.work?.checkout,
    basis: strategyBasis(service, issue),
    active: service.lifecycleTasks.has(issue.id),
  };
}
function selected(service, input) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((item) => item.id === input.issueId);
  requireThat(issue && /^[a-zA-Z0-9_-]+$/.test(issue.id), 'Select an existing issue.');
  requireThat(
    !['closed', 'ready-to-close'].includes(queue.lifecycle.find((stage) => stage.state === issue.state)?.role),
    'Reopen this issue explicitly before starting work.'
  );
  requireThat(
    input.basis === strategyBasis(service, issue),
    'The issue or strategy changed. Review the current issue before starting.'
  );
  requireThat(
    !service.lifecycleTasks.has(issue.id) && !service.issueChats.tasks.has(issue.id),
    'This issue is already working.'
  );
  requireThat(
    !service.store.runs.some((run) => run.issueId === issue.id && service.store.connected.has(run.id)),
    'Existing issue work is still connected. No duplicate was started.'
  );
  requireThat(
    !queue.actions.some(
      (action) => action.issues.includes(issue.id) && ['running', 'reserved', 'setup'].includes(action.status)
    ),
    'An existing assignment is still active. Reconcile it before changing execution strategy.'
  );
  return { queue, issue };
}
export function startIssueStrategy(service, input) {
  service.ownServer();
  const { queue, issue } = selected(service, input);
  requireThat(input.approved === true, 'Explicitly start this strategy for the displayed issue scope.');
  requireThat(['full-stop', 'full-send'].includes(input.strategy), 'Choose Full Stop or Full Send.');
  requireThat([0, 1, 3].includes(input.solRounds), 'Choose no Sol review, one round, or three rounds.');
  requireThat(['work', 'review'].includes(input.operation || 'work'), 'Choose work or an optional Sol review.');
  const record = service.lifecycleRuns[issue.id] || {
    id: randomUUID(),
    issueId: issue.id,
    events: [],
    attempts: [],
    retriedRuns: [],
  };
  const old = record.work;
  requireThat(!old || old.strategy !== 'full-send' || record.status !== 'merged', 'This issue was already merged.');
  requireThat(
    input.operation !== 'review' || old?.strategy === input.strategy,
    'Use Start to change the delivery strategy; a review alone grants no new merge permission.'
  );
  requireThat(
    input.operation !== 'review' || (old?.checkout && input.solRounds > 0),
    'Complete or retain issue work before requesting a Sol review.'
  );
  const config = old?.config || readJson(join(service.root, '.issues/issue-delivery-config.json'));
  requireThat(
    config.provider === 'github' && /^[\w.-]+\/[\w.-]+$/.test(config.repository) && config.remote && config.target,
    'Configure the issue repository, remote and target before starting.'
  );
  const run = service.store.add({ id: 'issue-' + issue.id }, 'issue-work', old?.base || queue.head);
  service.store.update(run, {
    issueId: issue.id,
    issueState: issue.state,
    summary: 'Starting the selected issue strategy.',
  });
  mkdirSync(join(service.store.directory, run.id), { recursive: true });
  const receipt = join(service.store.directory, run.id, 'strategy-approval.json');
  writeJson(receipt, {
    actor: 'human',
    type: 'issue-strategy-start',
    issueId: issue.id,
    strategy: input.strategy,
    report: digest(issue.content),
    plan: record.plan?.sha256 || null,
    solRounds: input.solRounds,
    config,
    operation: input.operation || 'work',
    instruction: String(input.instruction || ''),
    at: new Date().toISOString(),
  });
  const work = {
    ...old,
    priorInput: old?.priorInput || record.input || null,
    modelSettings: newChatModelSettings(service.root, issue.id),
    strategy: input.strategy,
    solRounds: input.solRounds,
    receipt,
    config,
    runId: run.id,
  };
  saveLifecycle(service, record, {
    work,
    stopRequested: false,
    pauseRequested: false,
    status: 'running',
    summary: 'Request accepted. Preparing the issue’s owning chat.',
    input: null,
  });
  appendMessage(service.root, issue.id, {
    id: 'strategy-start:' + run.id,
    actor: 'human',
    role: 'You',
    kind: 'strategy-start',
    body: `Started ${input.strategy}; ${input.solRounds ? input.solRounds + ' Sol review round(s)' : 'no Sol Loop'}. Scope and permissions: ${receipt}. ${input.instruction || ''}`,
  });
  const task = Promise.resolve()
    .then(() => executeStrategy(service, record, run, issue, input))
    .catch((error) => {
      const status = record.stopRequested || record.pauseRequested ? 'paused' : 'blocked';
      service.store.update(run, { status, summary: error.message, threadId: record.workThreadId || run.threadId });
      saveLifecycle(service, record, { status, summary: error.message });
      appendMessage(service.root, issue.id, {
        id: 'strategy-failed:' + run.id,
        actor: 'agent',
        role: 'Issue assistant',
        kind: 'strategy-result',
        body: error.message,
      });
    })
    .finally(() => {
      service.store.connected.delete(run.id);
      service.lifecycleTasks.delete(issue.id);
    });
  service.lifecycleTasks.set(issue.id, task);
  return { runId: run.id, issueId: issue.id, accepted: true };
}
async function checkoutFor(service, record, run, issue) {
  const work = record.work;
  if (!work.checkout) {
    const legacy = service.store.runs.findLast(
      (item) =>
        item.id !== run.id && item.issueId === issue.id && item.checkout && ['worker', 'issue-work'].includes(item.kind)
    );
    const delivery = service.deliveries.inspect(issue.id);
    const checkout = delivery?.checkout || legacy?.checkout;
    if (checkout) {
      work.checkout = realpathSync(checkout);
      work.branch = git(checkout, 'branch', '--show-current');
      work.base = legacy?.base || delivery?.contributions?.[0]?.originalBase || run.base;
      requireThat(
        work.branch && work.branch !== work.config.target,
        'Existing work is on the target branch. Preserve it before starting.'
      );
    } else {
      work.checkout = join(service.root, '.issues/issue-work', issue.id);
      work.branch = 'codex/issue-' + issue.id;
      work.base = run.base;
      mkdirSync(join(service.root, '.issues/issue-work'), { recursive: true });
      requireThat(!existsSync(work.checkout), 'An existing issue checkout needs manual reconciliation.');
      // Record identity before the effect, so uncertain creation never creates a second branch.
      saveLifecycle(service, record);
      git(service.root, 'worktree', 'add', '-b', work.branch, work.checkout, work.base);
    }
  }
  requireThat(
    realpathSync(resolve(work.checkout, git(work.checkout, 'rev-parse', '--git-common-dir'))) ===
      realpathSync(resolve(service.root, git(service.root, 'rev-parse', '--git-common-dir'))),
    'The checkout belongs to another repository.'
  );
  requireThat(
    git(work.checkout, 'branch', '--show-current') === work.branch && work.branch !== work.config.target,
    'The saved issue checkout changed branches. No work was started.'
  );
  service.store.update(run, { checkout: work.checkout, base: work.base });
  saveLifecycle(service, record);
}
export async function ownerTurn(service, record, run, issue, instruction = '') {
  requireThat(!record.stopRequested && !record.pauseRequested, 'Paused by you. Saved work is retained.');
  const work = record.work;
  const conversation = conversationState(service.root, issue.id);
  if (!record.workThreadId && conversation.threadId)
    saveLifecycle(service, record, { workThreadId: conversation.threadId });
  const threadId = await issueWorkChat(service, run, issue.id, work.checkout);
  saveConversationState(service.root, issue.id, { ...conversation, threadId, status: 'idle' });
  service.store.update(run, {
    threadId,
    status: 'running',
    summary: 'Working toward a merge-ready PR in the issue chat.',
  });
  const result = JSON.parse(
    await service.codex.turn(
      threadId,
      work.checkout,
      strategyPrompt(service.root, issue, work, instruction),
      strategyResultSchema,
      [],
      work.modelSettings
    )
  );
  service.store.update(run, { result, summary: result.summary });
  requireThat(
    result.outcome === 'completed',
    result.summary + (result.remaining?.length ? '\n' + result.remaining.join('\n') : '')
  );
  requireThat(Number.isSafeInteger(result.pr) && result.pr > 0, 'The worker did not return an actual PR number.');
  work.pr = result.pr;
  saveLifecycle(service, record);
  return result;
}
async function executeStrategy(service, record, run, issue, input) {
  const preflightProvider =
    service.strategyProvider?.(service.root, record.work.config) ||
    new StrategyProvider(service.root, record.work.config);
  if (record.work.strategy === 'full-send' && input.operation !== 'review')
    await preflightProvider.assertMergeProtection();
  requireThat(!record.stopRequested && !record.pauseRequested, 'Paused by you. Saved work is retained.');
  await checkoutFor(service, record, run, issue);
  const work = record.work;
  service.guard(
    service.root,
    { id: run.actionId, issues: [issue.id] },
    'implement',
    git(work.checkout, 'rev-parse', 'HEAD')
  );
  if (input.operation !== 'review') await ownerTurn(service, record, run, issue, input.instruction);
  requireThat(!record.stopRequested && !record.pauseRequested, 'Paused by you. Saved work is retained.');
  if (work.solRounds) await runSolLoop(service, record, run, issue, ownerTurn);
  requireThat(!git(work.checkout, 'status', '--porcelain'), 'Preserve the issue changes in a commit before handoff.');
  requireThat(!record.stopRequested && !record.pauseRequested, 'Stopped by you. Saved work is retained.');
  const head = git(work.checkout, 'rev-parse', 'HEAD');
  lifecycleEvent(service, record, 'Checking the final committed candidate.');
  service.store.update(run, { status: 'checking' });
  const checked = await service.check(work.checkout, work.base, join(service.store.directory, run.id));
  requireThat(
    checked.head === head && git(work.checkout, 'rev-parse', 'HEAD') === head,
    'The candidate changed during checks.'
  );
  requireThat(!record.stopRequested && !record.pauseRequested, 'Stopped by you. Checks and saved work are retained.');
  const provider =
    service.strategyProvider?.(work.checkout, work.config) || new StrategyProvider(work.checkout, work.config);
  const readiness = await provider.ready(await provider.inspect(work.pr), work.branch, head);
  writeJson(join(service.store.directory, run.id, 'readiness.json'), { ...readiness, checked });
  work.readiness = readiness;
  if (work.strategy === 'full-send' && input.operation !== 'review') {
    service.guard(
      service.root,
      { id: run.actionId, issues: [issue.id], worker_revision: head },
      'merge',
      readiness.target
    );
    // Recheck the live PR immediately before the provider-enforced merge.
    await provider.ready(await provider.inspect(work.pr), work.branch, head);
    requireThat(!record.stopRequested && !record.pauseRequested, 'Stopped before merging. The PR remains open.');
    work.merge = await provider.merge(work.pr, head);
  }
  const status = work.merge ? 'merged' : 'handed-off';
  const summary = work.merge
    ? `Merged ${work.merge.url}. Human acceptance remains separate.`
    : `Ready for you to merge: ${readiness.url}. The PR is open and unmerged.`;
  saveLifecycle(service, record, { status, summary, work });
  service.store.update(run, {
    status: 'completed',
    summary,
    result: { ...run.result, readiness, checked, merge: work.merge || null },
  });
  appendMessage(service.root, issue.id, {
    id: 'strategy-result:' + run.id,
    actor: 'agent',
    role: 'Issue assistant',
    kind: 'strategy-result',
    body: summary,
  });
}

export async function stopIssueStrategy(service, input) {
  service.ownServer();
  const record = service.lifecycleRuns[input.issueId];
  requireThat(
    record?.work?.runId === input.runId && service.lifecycleTasks.has(input.issueId),
    'This issue operation is no longer active.'
  );
  saveLifecycle(service, record, { stopRequested: true, summary: 'Stopping. Saved work will be kept.' });
  const run = service.store.runs.find((entry) => entry.id === input.runId);
  const turn = service.codex.turns.get(run.threadId);
  if (turn) {
    const started = await turn.started;
    await service.codex.call('turn/interrupt', { threadId: run.threadId, turnId: started.turn.id });
  }
  return { stopping: true };
}
