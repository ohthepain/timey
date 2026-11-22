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
import { updateStoredIssueMetadata } from './issue-report-storage.mjs';
import { resolveIssueExecutionSettings } from './issue-execution-settings.mjs';
import { investigationIssueView, investigationConfiguration } from './investigation-history.mjs';
import { isInvestigation } from './investigation-records.mjs';
import { inquiryKinds } from './investigation-flow.mjs';
import {
  configureInvestigationInquiry,
  executeInvestigationOutputs,
  usesInvestigationOutputs,
  retryOutputKinds,
} from './investigation-execution.mjs';

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
    if (flows) flows.investigations = this;
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
    if (!this.flows) return [...this.sessions.values()].toReversed().map((session) => structuredClone(session));
    return this.flows
      .issues()
      .filter((issue) => issue.location === 'open' && isInvestigation(issue, this.flows.read(issue)))
      .map((issue) => {
        const saved = [...this.sessions.values()].findLast((session) => session.issueId === issue.id);
        return {
          id: issue.id,
          issueId: issue.id,
          focus: issue.title,
          status: saved?.status || 'draft',
          updatedAt: issue.updated,
        };
      });
  }
  issueView(issueId) {
    return investigationIssueView(this, issueId);
  }
  busyIssue(issueId) {
    return (
      [...this.active.keys()].some((id) => this.sessions.get(id)?.issueId === issueId) || this.flows.active.has(issueId)
    );
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
    if (input.action === 'investigation-create') return this.create(input);
    if (input.action === 'investigation-save') return this.configure(input);
    requireThat(
      input.issueId || input.id || this.sessions.has(input.requestId),
      'Create the investigation first, then run it from its issue page.'
    );
    requireThat(
      ['investigation-discuss', 'investigation-run', 'investigation-retry', 'investigation-stop'].includes(
        input.action
      ),
      'Choose an investigation operation.'
    );
    if (input.action === 'investigation-stop') return this.stop(this.selected(input.id));
    let session = input.id ? this.selected(input.id) : this.sessions.get(identity(input.requestId));
    const submitted = session?.requests?.[input.requestId];
    if (submitted) {
      requireThat(
        submitted === digest(JSON.stringify(input)),
        'This operation identity already contains different wording.'
      );
      return { session: structuredClone(session) };
    }
    if (session && this.active.has(session.id)) return { session: structuredClone(session) };
    const configuration = this.runInput(input);
    const operation = await this.operation(configuration, session);
    if (this.replayed(session, operation)) return { session: structuredClone(session) };
    if (!session) {
      session = {
        id: operation.requestId,
        captureId: operation.requestId,
        createdAt: new Date().toISOString(),
        messages: [],
        receipts: {},
        ...(input.issueId && { issueId: input.issueId }),
      };
      this.sessions.set(session.id, session);
    }
    if (session.issueId) {
      requireThat(
        this.flows.selected(session.issueId).location === 'open',
        'Restore the investigation before running it.'
      );
      requireThat(!this.busyIssue(session.issueId), 'This investigation is already running.');
    }
    session.requests ||= {};
    if (input.requestId) session.requests[input.requestId] = digest(JSON.stringify(input));
    this.beginOperation(session, operation);
    return { session: structuredClone(session) };
  }
  runInput(input) {
    if (!input.issueId) return input;
    const view = this.issueView(input.issueId);
    requireThat(!view.archived && !view.needsApproval, 'Restore or approve this investigation before running it.');
    requireThat(!this.busyIssue(input.issueId), 'This investigation is already running.');
    requireThat(
      input.action === 'investigation-discuss' || view.reusable || !view.runs.some((run) => run.status === 'completed'),
      'Enable Reusable before starting another completed investigation.'
    );
    return { ...view.configuration, ...input, folder: input.folder || defaultIssueFolder(this.service.root).name };
  }
  async create(input) {
    const config = await this.configuration(input);
    requireThat(
      input.reusable === undefined || typeof input.reusable === 'boolean',
      'Choose a valid Reusable setting.'
    );
    const result = await this.flows.capture({
      requestId: input.requestId,
      description: this.brief(config),
      type: 'investigation',
      folder: input.issueFolder || defaultIssueFolder(this.service.root).name,
      startingRef: config.branch,
      reusable: input.reusable === true,
    });
    requireThat(!result.deleted, 'This investigation was deleted. Create another investigation.');
    return { issueId: result.issue.id };
  }
  async configure(input) {
    const issue = this.flows.selected(input.issueId);
    const flow = this.flows.read(issue);
    requireThat(isInvestigation(issue, flow) && issue.location === 'open', 'Choose an open investigation.');
    requireThat(!this.busyIssue(issue.id), 'Wait for this investigation to finish before editing it.');
    requireThat(
      input.revision === flow.revision && typeof input.reusable === 'boolean',
      'This investigation changed. Refresh before saving.'
    );
    const config = await this.configuration({ ...investigationConfiguration(this, issue, flow), ...input });
    requireThat(
      this.flows.read(this.flows.selected(issue.id)).revision === flow.revision,
      'This investigation changed. Refresh before saving.'
    );
    const shared = this.service.sharedIssues?.acquireForApproval(issue);
    await updateStoredIssueMetadata(this.service.root, issue, {
      request_type: 'investigation',
      reusable: input.reusable,
      updated: new Date().toISOString(),
    });
    flow.investigation = {
      focus: config.focus,
      prompt: config.prompt,
      instructions: config.instructions,
      branch: config.branch,
    };
    await this.flows.store.save(flow, flow.revision);
    if (shared) this.service.sharedIssues.checkpoint(issue.id, 'Investigation settings updated', shared);
    return this.issueView(issue.id);
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
    signal.throwIfAborted();
    if (flow.workspace) flow.legacyInvestigationWorkspace ??= flow.workspace;
    flow.workspace = null;
    flow.startingPoint = session.startingPoint;
    const fresh = {
      ...flow,
      settings: { ...flow.settings, branch: session.startingPoint.name },
      executionSettings: undefined,
      destination: undefined,
    };
    const settings = resolveIssueExecutionSettings(this.service.root, issue, fresh, { started: false });
    requireThat(!settings.errors.length, 'Fix investigation or folder settings before running.');
    session.settings = settings.values;
    flow.executionSettings = { values: settings.values, sources: settings.sources, basis: settings.basis };
    const catalog = this.flows.catalog.read().entries;
    let block = flow.blocks.find(({ kind }) => inquiryKinds.has(kind));
    if (!block) {
      block = makeBlock('investigate', [requestBlock(flow).id], false, catalog);
      flow.blocks.push(block);
    }
    block.suggested = false;
    configureInvestigationInquiry(flow, block, session, this.modelPrompt(session));
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
    flow.projectInvestigation = {
      sessionId: session.id,
      automaticFollowups: !session.flowOutputs,
      folder: session.folder,
    };
    flow.investigation = {
      ...flow.investigation,
      focus: session.focus,
      branch: session.branch,
      prompt: session.prompt,
      instructions: session.instructions,
    };
    await this.flows.store.save(flow, flow.revision);
    session.blockId = block.id;
    this.save(session);
    return block;
  }
  modelPrompt(session) {
    const discussion = session.messages.map(({ role, text }) => role + ': ' + text).join('\n\n');
    return [
      session.mode === 'discussion'
        ? 'This turn is a preliminary investigation conversation. Answer the current codebase question using observed evidence and help refine the investigation goal. Ask focused grilling questions when useful. Do not perform the full investigation or claim it was started. The user must explicitly press Run.'
        : 'Run the agreed whole-project investigation. Identify concrete codebase or working-process improvements with supporting evidence, bounded scope, and a verification method. Omit unsupported speculation and already-addressed work. Do not implement changes or create issues yourself. The included output blocks independently use the retained findings.',
      this.brief(session),
      '## Retained investigation conversation\n' + discussion,
      '## Previous discussion (historical context)\n' +
        JSON.stringify(
          [...this.sessions.values()]
            .filter((entry) => entry.issueId === session.issueId && entry.id !== session.id)
            .flatMap((entry) => entry.messages)
            .slice(-30)
            .map(({ role, text }) => ({ role, text: text.slice(0, 2000), truncated: text.length > 2000 }))
        ),
      '## Earlier runs (historical context; recheck all findings against this revision)\n' +
        JSON.stringify(
          this.issueView(session.issueId)
            .runs.slice(0, 5)
            .map(({ id, summary, issues, output }) => ({
              id,
              summary,
              issues,
              findings: output.slice(0, 12000),
              truncated: output.length > 12000,
            }))
        ),
    ].join('\n\n');
  }
  async perform(session, signal, retry) {
    await this.ensureIssue(session, signal);
    if (!(retry && session.followupSource && session.mode === 'investigation'))
      await this.executeTurn(session, signal, retry);
    await this.finishInvestigation(session, signal, retry);
    signal.throwIfAborted();
    session.status = session.mode === 'discussion' ? 'draft' : 'completed';
    this.save(session);
  }
  async finishInvestigation(session, signal, retry) {
    if (session.mode !== 'investigation') return;
    if (usesInvestigationOutputs(this, session))
      await executeInvestigationOutputs(this, session, signal, retry, retryOutputKinds(session));
    else await this.createFollowups(session, signal);
  }
  recoveryBlock(session, retry) {
    if (!retry) return null;
    const flow = this.flows.read(this.flows.selected(session.issueId));
    const block = flow.blocks.find((block) => block.attempts.some(unresolved));
    if (!block) return null;
    requireThat(
      inquiryKinds.has(block.kind) && block.id === session.blockId,
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
      investigationOperation: session.id,
      investigation: {
        mode: session.mode,
        prompt: session.prompt,
        instructions: session.instructions,
        settings: session.settings,
        startingPoint: session.startingPoint,
        folder: session.folder,
      },
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
        settings: session.settings,
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
    session.trackedIssues = projectIssueRecords(this.service.root)
      .filter(
        (issue) =>
          issue.source_issue === session.issueId &&
          issue.source_attempt !== source.attemptId &&
          issue.location === 'open'
      )
      .map(({ id }) => id);
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
