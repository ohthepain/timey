import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';
import { appendMessage } from './conversation-store.mjs';
import { branchStartingPoint, flowBranches } from './flow-branches.mjs';
import { flowTarget } from './flow-observer.mjs';
import { requestBlock, latestCurrentAttempt } from './flow-block-data.mjs';
import { makeBlock } from './flow-store.mjs';
import { defaultIssueFolder, requireIssueFolder, resolveFolderSettings } from './issue-folder-settings.mjs';
import { FlowFollowups } from './flow-followups.mjs';
import { proposeProjectFollowups } from './project-home-proposals.mjs';
import { projectIssueRecords } from './project-home-stats.mjs';
import { moveInvestigationBranch } from './project-home-branch.mjs';

export const investigationFocuses = [
  'Whole codebase',
  'Architecture',
  'Code quality',
  'Tests',
  'Performance',
  'Working processes',
  'Custom',
];

export const investigationPrompts = {
  'Whole codebase':
    'Investigate the project as a whole. Find the most valuable concrete improvements to its codebase and working processes.',
  Architecture:
    'Investigate architecture, ownership, dependencies, and module interfaces. Find changes that reduce complexity or prevent mistakes.',
  'Code quality':
    'Investigate code quality. Find concrete defects, recurring error patterns, and opportunities to simplify important code.',
  Tests:
    'Investigate the project tests and verification process. Find important behaviors that are unproven or checks that give misleading confidence.',
  Performance:
    'Investigate performance. Identify measurable bottlenecks and bounded experiments or improvements, distinguishing observations from hypotheses.',
  'Working processes':
    'Investigate the project working processes, agent workflows, and retained issue history. Find concrete ways to prevent recurring friction or mistakes.',
  Custom: 'Investigate the following project concern using observed evidence.',
};

const busyStatuses = new Set(['running', 'stopping']);
function unresolved(attempt) {
  return !attempt.reconciledAt && ['uncertain', 'running', 'stopping'].includes(attempt.status);
}
export function projectDefaultBranch(branches, name, remote) {
  return (
    branches.find(({ ref }) => ref === 'refs/heads/' + name) ??
    branches.find(({ name: branch }) => branch === remote + '/' + name)
  );
}
function text(value, maximum, label, optional = false) {
  requireThat(typeof value === 'string' && value.length <= maximum && (optional || value.trim()), label);
  return value.trim();
}
function identity(value) {
  requireThat(typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value), 'Use a stable operation identity.');
  return value;
}
function normalizedTitle(value) {
  return String(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class ProjectInvestigations {
  constructor(service, flows, options = {}) {
    this.service = service;
    this.flows = flows;
    this.options = options;
    this.readOnly = options.readOnly === true;
    this.directory = join(service.root, '.issues/factory-ui/project-home/investigations');
    this.active = new Map();
    this.pending = new Map();
    this.sessions = new Map();
    if (!this.readOnly) mkdirSync(this.directory, { recursive: true });
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const saved = JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
      requireThat(saved.id + '.json' === name, 'The saved investigation identity needs reconciliation.');
      this.sessions.set(saved.id, saved);
      if (!this.readOnly && busyStatuses.has(saved.status)) {
        saved.status = 'interrupted';
        saved.error = 'The server stopped during this operation. Inspect the retained issue and explicitly Retry.';
        this.save(saved);
      }
    }
  }
  get activeCount() {
    return (
      [...this.active.keys()].filter((id) => !this.flows.active.has(this.sessions.get(id)?.issueId)).length +
      this.pending.size
    );
  }
  view() {
    return [...this.sessions.values()].toReversed().map((session) => structuredClone(session));
  }
  save(session) {
    session.updatedAt = new Date().toISOString();
    writeJson(join(this.directory, identity(session.id) + '.json'), session);
  }
  selected(id) {
    const session = this.sessions.get(identity(id));
    requireThat(session, 'Choose a saved investigation.');
    return session;
  }
  async configuration(input, previous = {}) {
    const settings = resolveFolderSettings(this.service.root, null);
    requireThat(!settings.errors.length, 'Fix project settings before starting an investigation.');
    const branches = await flowBranches(this.service.root);
    const defaultBranch = projectDefaultBranch(branches, settings.values.branch, flowTarget(this.service.root).remote);
    const defaults = {
      focus: 'Whole codebase',
      branch: defaultBranch?.ref,
      instructions: '',
      folder: defaultIssueFolder(this.service.root).name,
    };
    const values = {
      ...defaults,
      ...previous,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    };
    const branch = branchStartingPoint(branches, values.branch);
    requireThat(investigationFocuses.includes(values.focus), 'Choose an investigation focus.');
    return {
      focus: values.focus,
      branch: branch.ref,
      startingPoint: branch,
      prompt: text(
        values.prompt ?? investigationPrompts[values.focus],
        12000,
        'Describe the investigation in under 12,000 characters.'
      ),
      instructions: text(values.instructions, 4000, 'Keep additional instructions under 4,000 characters.', true),
      folder: requireIssueFolder(this.service.root, values.folder).name,
      settings: settings.values,
    };
  }
  async action(input) {
    requireThat(!this.readOnly, 'This preview is read-only. Open the live project to start an investigation.');
    const key = identity(input.id || input.requestId);
    const fingerprint = digest(JSON.stringify(input));
    const pending = this.pending.get(key);
    if (pending) {
      requireThat(pending.fingerprint === fingerprint, 'Another operation is being saved for this investigation.');
      return pending.task;
    }
    const task = this.dispatch(input);
    this.pending.set(key, { fingerprint, task });
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async dispatch(input) {
    requireThat(
      ['investigation-discuss', 'investigation-run', 'investigation-retry', 'investigation-stop'].includes(
        input.action
      ),
      'Choose an investigation operation.'
    );
    if (input.action === 'investigation-stop') return this.stop(this.selected(input.id));
    let session = input.id ? this.selected(input.id) : this.sessions.get(identity(input.requestId));
    if (session && this.active.has(session.id)) return { session: structuredClone(session) };
    const operation = await this.operation(input, session);
    if (this.replayed(session, operation)) return { session: structuredClone(session) };
    if (!session) {
      session = {
        id: operation.requestId,
        captureId: operation.requestId,
        createdAt: new Date().toISOString(),
        messages: [],
        receipts: {},
      };
      this.sessions.set(session.id, session);
    }
    this.beginOperation(session, operation);
    return { session: structuredClone(session) };
  }
  async operation(input, session) {
    const retry = input.action === 'investigation-retry';
    const config = retry ? this.retryConfiguration(session) : await this.configuration(input, session);
    const mode = retry ? session.mode : input.action === 'investigation-discuss' ? 'discussion' : 'investigation';
    const message = this.operationMessage(input, session, mode, retry);
    return {
      retry,
      config,
      mode,
      message,
      requestId: identity(input.requestId || randomUUID()),
      fingerprint: digest(JSON.stringify([mode, config, message])),
    };
  }
  retryConfiguration(session) {
    requireThat(
      session && ['failed', 'stopped', 'interrupted'].includes(session.status),
      'Choose an interrupted or unsuccessful investigation to retry.'
    );
    return Object.fromEntries(
      ['focus', 'branch', 'startingPoint', 'prompt', 'instructions', 'folder', 'settings'].map((key) => [
        key,
        session[key],
      ])
    );
  }
  operationMessage(input, session, mode, retry) {
    if (mode !== 'discussion') return '';
    const message = input.message ?? (retry ? session.lastMessage : '');
    return text(message, 8000, 'Enter a question in under 8,000 characters.');
  }
  replayed(session, operation) {
    const receipt = session?.receipts?.[operation.requestId];
    if (!receipt) return false;
    requireThat(receipt === operation.fingerprint, 'This operation identity already contains different wording.');
    return true;
  }
  beginOperation(session, operation) {
    const { config, mode, message, requestId, fingerprint, retry } = operation;
    Object.assign(session, config, { mode, status: 'running', error: null, lastMessage: message });
    session.receipts[requestId] = fingerprint;
    session.operationId = requestId;
    if (!retry) {
      delete session.followupSource;
      delete session.followups;
      delete session.followupBasis;
      delete session.result;
      session.messages.push({ role: 'user', text: message || this.brief(session), at: new Date().toISOString() });
    }
    this.save(session);
    const controller = new AbortController();
    const task = Promise.resolve()
      .then(() => this.perform(session, controller.signal, retry))
      .catch((error) => {
        session.status = controller.signal.aborted ? 'stopped' : 'failed';
        session.error = redactValue(error.message);
        this.save(session);
      })
      .finally(() => this.active.delete(session.id));
    this.active.set(session.id, { controller, task });
  }
  brief(session) {
    return [
      session.focus + ' investigation',
      session.prompt,
      session.instructions,
      '## Branch',
      session.startingPoint.name + ' at ' + session.startingPoint.commit,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  async ensureIssue(session, signal) {
    if (session.issueId) return;
    // The immutable capture wording survives retries even after a discussion changes the brief.
    session.captureDescription ||= this.brief(session);
    session.captureFolder ||= defaultIssueFolder(this.service.root).name;
    session.captureRef ||= session.branch;
    this.save(session);
    const created = await this.flows.capture({
      requestId: session.captureId,
      description: session.captureDescription,
      type: 'investigation',
      folder: session.captureFolder,
      startingRef: session.captureRef,
    });
    requireThat(!created.deleted, 'This investigation issue was deleted. Start a new investigation.');
    session.issueId = created.issue?.id ?? created.issueId;
    requireThat(session.issueId, 'The investigation issue was not saved.');
    this.save(session);
    signal.throwIfAborted();
  }
  async prepareBlock(session, signal) {
    let issue = this.flows.selected(session.issueId);
    let flow = this.flows.read(issue);
    requireThat(!issue.closed, 'Reopen the investigation issue before continuing.');
    requireThat(!this.flows.active.has(issue.id), 'Wait for the issue’s active block before continuing here.');
    const pendingBlock = flow.blocks.find((block) => block.attempts.some(unresolved));
    requireThat(!pendingBlock, 'The original provider attempt needs reconciliation in the issue before Retry.');
    if (flow.startingPoint?.ref !== session.branch || flow.startingPoint?.commit !== session.startingPoint.commit) {
      await moveInvestigationBranch(this.service, this.flows, issue, flow, session.startingPoint);
      signal.throwIfAborted();
      issue = this.flows.selected(session.issueId);
      flow = this.flows.read(issue);
    }
    const catalog = this.flows.catalog.read().entries;
    let block = flow.blocks.find(({ kind }) => kind === 'understand');
    if (!block) {
      block = makeBlock('understand', [requestBlock(flow).id], false, catalog);
      flow.blocks.push(block);
    }
    block.skill = '';
    block.skillExplicit = true;
    block.suggested = false;
    block.prompt = this.modelPrompt(session);
    const request = requestBlock(flow);
    request.data.fields = {
      type: 'investigation',
      goal: session.prompt,
      requestedProof:
        'Cite observed source locations or retained history for every finding. State uncertainty and a concrete verification for each bounded improvement.',
      knownFacts:
        'Whole-project investigation at ' + session.startingPoint.name + ' (' + session.startingPoint.commit + ').',
      constraints: 'Read-only project source. ' + session.instructions,
    };
    flow.settings = { ...flow.settings, model: session.settings.model, effort: session.settings.effort, skill: 'none' };
    flow.projectInvestigation = { sessionId: session.id, automaticFollowups: true, folder: session.folder };
    this.flows.store.save(flow, flow.revision);
    session.blockId = block.id;
    this.save(session);
    return block;
  }
  modelPrompt(session) {
    const discussion = session.messages.map(({ role, text }) => role + ': ' + text).join('\n\n');
    return [
      session.mode === 'discussion'
        ? 'This turn is a preliminary investigation conversation. Answer the current codebase question using observed evidence and help refine the investigation goal. Ask focused grilling questions when useful. Do not perform the full investigation or claim it was started. The user must explicitly press Run.'
        : 'Run the agreed whole-project investigation. Identify concrete codebase or working-process improvements with supporting evidence, bounded scope, and a verification method. Omit unsupported speculation and already-addressed work. Do not implement changes or create issues yourself; Factory creates approval-needed follow-ups from retained findings.',
      this.brief(session),
      '## Retained investigation conversation\n' + discussion,
    ].join('\n\n');
  }
  async perform(session, signal, retry) {
    await this.ensureIssue(session, signal);
    if (!(retry && session.followupSource && session.mode === 'investigation'))
      await this.executeTurn(session, signal, retry);
    if (session.mode === 'investigation') await this.createFollowups(session, signal);
    signal.throwIfAborted();
    session.status = session.mode === 'discussion' ? 'draft' : 'completed';
    this.save(session);
  }
  recoveryBlock(session, retry) {
    if (!retry) return null;
    const flow = this.flows.read(this.flows.selected(session.issueId));
    const block = flow.blocks.find((block) => block.attempts.some(unresolved));
    if (!block) return null;
    requireThat(
      block.kind === 'understand' && block.id === session.blockId,
      'Reconcile the issue’s other operation before retrying this investigation.'
    );
    requireThat(
      flow.startingPoint?.ref === session.branch && flow.startingPoint?.commit === session.startingPoint.commit,
      'The investigation branch changed. Reconcile its original attempt in the issue workspace.'
    );
    return block;
  }
  async executeTurn(session, signal, retry) {
    const previous = this.recoveryBlock(session, retry);
    const block = previous || (await this.prepareBlock(session, signal));
    const flow = this.flows.read(this.flows.selected(session.issueId));
    appendMessage(this.service.root, session.issueId, {
      id: 'project-investigation-' + session.operationId,
      actor: 'human',
      role: 'You',
      kind: 'project-investigation',
      body: session.lastMessage || this.brief(session),
      blockId: block.id,
    });
    signal.throwIfAborted();
    const accepted = await this.flows.action({
      action: previous ? 'continue' : 'start',
      issueId: session.issueId,
      blockId: block.id,
      revision: flow.revision,
    });
    session.attemptId = accepted.attemptId;
    this.save(session);
    await this.waitForBlock(session, signal);
    const finished = this.flows.read(this.flows.selected(session.issueId)).blocks.find(({ id }) => id === block.id);
    this.retainResult(session, block, latestCurrentAttempt(finished));
  }
  async waitForBlock(session, signal) {
    const active = this.flows.active.get(session.issueId);
    const stopBlock = () => active?.controller.abort();
    signal.addEventListener('abort', stopBlock, { once: true });
    if (signal.aborted) stopBlock();
    try {
      await active?.task;
    } finally {
      signal.removeEventListener('abort', stopBlock);
    }
    signal.throwIfAborted();
  }
  retainResult(session, block, attempt) {
    requireThat(
      attempt?.id === session.attemptId && attempt.status === 'completed',
      attempt?.summary || 'The investigation did not finish. Inspect its saved attempt.'
    );
    session.result = attempt.output || attempt.summary;
    session.messages.push({ role: 'assistant', text: session.result, at: new Date().toISOString() });
    if (session.mode === 'investigation')
      session.followupSource = {
        issueId: session.issueId,
        blockId: block.id,
        attemptId: attempt.id,
        attemptDigest: digest(JSON.stringify(attempt)),
      };
    this.save(session);
  }
  async createFollowups(session, signal) {
    session.phase = 'Creating follow-up issues';
    this.save(session);
    const propose = this.options.propose || ((context) => proposeProjectFollowups(this.service.root, context, signal));
    const followups = new FlowFollowups(this.flows, (context) =>
      propose({
        ...context,
        existingIssues: projectIssueRecords(this.service.root).map(({ id, title, state }) => ({ id, title, state })),
      })
    );
    const source = session.followupSource;
    this.requireCurrentFindings(session);
    const preview = await followups.action({ ...source, action: 'investigation-followups-preview' });
    signal.throwIfAborted();
    this.requireCurrentFindings(session);
    session.followupBasis ??= preview.source.basis;
    requireThat(
      session.followupBasis === preview.source.basis,
      'The investigation changed. Run the investigation again before creating new follow-ups.'
    );
    this.save(session);
    const titles = new Set(projectIssueRecords(this.service.root).map(({ title }) => normalizedTitle(title)));
    const items = preview.proposals.filter((proposal) => {
      const title = normalizedTitle(proposal.title);
      if (proposal.result || !titles.has(title)) {
        titles.add(title);
        return true;
      }
      return false;
    });
    let result = preview;
    for (const item of items) {
      signal.throwIfAborted();
      this.requireCurrentFindings(session);
      result = await followups.action({
        ...source,
        action: 'investigation-followups-create',
        basis: preview.source.basis,
        items: [item],
        folder: session.folder,
      });
      this.saveFollowupOutcome(session, result);
    }
    this.saveFollowupOutcome(session, result);
    delete session.phase;
  }
  saveFollowupOutcome(session, result) {
    session.followups = result.proposals.map(({ id, title, result, error }) => ({ id, title, ...result, error }));
    this.save(session);
    requireThat(
      !result.proposals.some(({ error }) => error),
      'Some follow-up issues could not be created. Retry to create only the remaining issues.'
    );
  }
  requireCurrentFindings(session) {
    const source = session.followupSource;
    const flow = this.flows.read(this.flows.selected(session.issueId));
    const block = flow.blocks.find(({ id }) => id === source.blockId);
    const attempt = latestCurrentAttempt(block);
    requireThat(
      attempt?.id === source.attemptId,
      'The investigation findings changed. Run the investigation again before creating new follow-ups.'
    );
    requireThat(
      digest(JSON.stringify(attempt)) === source.attemptDigest,
      'The retained investigation result changed. Run the investigation again before creating new follow-ups.'
    );
  }
  stop(session) {
    const active = this.active.get(session.id);
    requireThat(active, 'This investigation is no longer running.');
    session.status = 'stopping';
    this.save(session);
    active.controller.abort();
    return { session: structuredClone(session) };
  }
  close() {
    for (const { controller } of this.active.values()) controller.abort();
  }
}
