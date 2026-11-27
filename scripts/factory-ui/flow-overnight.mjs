import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redactValue } from './activity.mjs';
import { digest, readJson, requireThat, writeJson } from './common.mjs';
import { issueDependencies } from './data.mjs';
import { deliveryTarget, latestCurrentAttempt, requestBlock } from './flow-block-data.mjs';
import { folderName } from './flow-store.mjs';
import { issueHasActiveWork } from './issue-cleanup.mjs';
import { groupChildren } from './issue-group.mjs';
import { listStoredIssues } from './issue-report-storage.mjs';
import { mergedDelivery } from './merged-issue.mjs';

const strategies = new Set(['same-blast-radius', 'different-blast-radii']);
const finishLine = 'Follow each issue’s configured merge policy';
const protectionOnly = new Set(['close', 'retro', 'cleanup', 'delete-worktree']);
const inspectionActions = new Set([
  'open-block',
  'comment',
  'open-worktree',
  'stop',
  'branch-repair-stop',
  'agent-answer',
]);
const end = (row, status, summary, nextAction) => Object.assign(row, { status, summary, nextAction });
const identity = ({ issue, flow }) => digest(JSON.stringify([issue.content, flow.revision]));
const publicIssue = ({ id, title, issueNumber }) => ({ id, title, issueNumber });
const unresolvedStatuses = new Set(['running', 'stopping', 'uncertain']);
const retryableStatuses = new Set(['failed', 'blocked', 'stopped']);

function interrupted(report) {
  if (!['running', 'stopping'].includes(report.status)) return report;
  return {
    ...report,
    status: 'interrupted',
    finishedAt: report.updatedAt,
    issues: report.issues.map((row) =>
      ['queued', 'running'].includes(row.status)
        ? end(
            { ...row },
            'paused',
            'The server stopped during this run.',
            'Inspect retained work before starting again.'
          )
        : row
    ),
  };
}

function recordFailure(row, block, attempt) {
  row.failedCheck = block.label;
  end(row, 'paused', attempt?.summary || `${block.label} needs attention.`, `Open ${block.label} to continue.`);
}

function recordMergedIssue(row, attempt, flow, merged) {
  Object.assign(row, { pr: merged.pr, url: flow.destination?.url });
  end(row, 'merged', attempt.summary, 'Open the issue to review the result.');
}

function recordMergeAttempt(row, block, attempt, flow) {
  const merged = mergedDelivery(flow);
  if (merged) return recordMergedIssue(row, attempt, flow, merged);
  const mergeConfirmation = attempt.result?.mergeConfirmation;
  if (mergeConfirmation) {
    const { pr, url } = mergeConfirmation;
    Object.assign(row, { pr, url });
    end(row, 'ready', attempt.summary, 'Open Merge to approve the current candidate.');
    return;
  }
  recordFailure(row, block, attempt);
}

function savedAttempt(flow, blockId) {
  const block = flow.blocks.find(({ id }) => id === blockId);
  return block && latestCurrentAttempt(block);
}

function recordAttempt(row, block, flow) {
  const attempt = savedAttempt(flow, block.id) ?? {};
  if (block.kind === 'merge') return recordMergeAttempt(row, block, attempt, flow);
  if (attempt.status !== 'completed') recordFailure(row, block, attempt);
}

function blockNeedsAttention(row, block) {
  if (!block || protectionOnly.has(block.kind)) {
    end(row, 'paused', 'The flow reached its end without a recorded merge.', 'Review the saved flow and PR.');
    return true;
  }
  return attemptNeedsAttention(row, block);
}

function attemptNeedsAttention(row, block) {
  const previous = latestCurrentAttempt(block);
  if (!previous) return false;
  if (!previous.input && !unresolvedStatuses.has(previous.status)) return false;
  end(row, 'paused', previous.summary, `Open ${block.label} to continue.`);
  return true;
}

function dependencyLabel(issue) {
  return issue.issueNumber ? `#${issue.issueNumber}` : issue.title;
}

function nextAction(block) {
  return retryableStatuses.has(latestCurrentAttempt(block)?.status) ? 'continue' : 'start';
}

function runKey(run) {
  return run.project ? run.id : run.folder;
}

export function nightDiscussionContext(flows, id) {
  const run = flows.overnight.projectRun(id);
  const candidates = flows.folderSelection
    .entries()
    .filter(({ issue, flow }) => flows.groupEligible(issue, flow) && issue.state !== 'needs-approval')
    .map(({ issue, flow }) => ({
      ...publicIssue(issue),
      folder: flow.folder,
      storeId: issue.storeId,
      target: deliveryTarget(flow).branch,
      request: requestBlock(flow).data.wording.slice(0, 4000),
    }));
  return redactValue({
    instructions:
      'Give suggestions and reasons only. The person applies changes through the overnight planner. Explain concrete overlap and target or store restrictions.',
    run,
    candidates,
  });
}

export class FlowOvernight {
  constructor(flows) {
    this.flows = flows;
    this.path = join(flows.store.directory, 'folder-night-runs.json');
    this.draftPath = join(flows.store.directory, 'project-night-drafts.json');
    this.plans = new Map();
    this.running = new Map();
    this.owners = new Map();
    this.closed = false;
  }

  reports() {
    const saved = existsSync(this.path) ? readJson(this.path) : {};
    return Object.fromEntries(
      Object.entries(saved).map(([folder, report]) => [folder, this.running.has(folder) ? report : interrupted(report)])
    );
  }

  save(run) {
    mkdirSync(this.flows.store.directory, { recursive: true });
    run.updatedAt = new Date().toISOString();
    writeJson(this.path, { ...this.reports(), [runKey(run)]: run });
    this.flows.service.flowChanges?.notify();
  }

  owns(issueId, runId) {
    const owner = this.owners.get(issueId);
    return Boolean(owner && (runId === undefined || runId === owner.id));
  }

  requireManualAction(issueId, action) {
    requireThat(
      !this.owns(issueId) || inspectionActions.has(action),
      'Stop Work All Night before changing this issue.'
    );
  }

  action(input) {
    if (input.action === 'folder-night-plan') return this.plan(input);
    if (input.action === 'folder-night-start') return this.start(input.planId);
    if (input.action === 'folder-night-stop') return this.stop(folderName(input.folder));
    return this.projectAction(input);
  }

  roster(folder, ids) {
    const entries = this.selectRoster(folder, ids);
    for (const { issue, flow } of entries) this.requireIdle(issue, flow);
    return entries;
  }

  selectRoster(folder, ids) {
    requireThat(
      Array.isArray(ids) && ids.length && ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length,
      'Choose the issues to run overnight.'
    );
    const eligible = new Map(this.flows.folderSelection.entries(folder).map((entry) => [entry.issue.id, entry]));
    return ids.map((id) => {
      const entry = eligible.get(id);
      requireThat(
        entry,
        folder ? 'A selected issue is no longer in this folder.' : 'A selected issue is no longer open.'
      );
      return entry;
    });
  }

  requireIdle(issue, flow) {
    requireThat(!issue.closed, `“${issue.title}” is closed.`);
    this.flows.groups.requireIndependent(issue.id);
    this.flows.groups.requireChildren(issue);
    this.flows.requireAvailableAction(issue, flow, 'play');
    requireThat(!this.busy(issue.id), `“${issue.title}” already has work in progress or work to reconcile.`);
  }

  busy(issueId) {
    return this.owns(issueId) || this.busyFlow(issueId) || issueHasActiveWork(this.flows.service, issueId);
  }

  busyFlow(issueId) {
    const { active, autoplay, service } = this.flows;
    if (active.has(issueId)) return true;
    return ['playing', 'waiting'].includes(autoplay.get(issueId)?.mode) || service.issueChats?.active?.has(issueId);
  }

  plan({ folder: name, issueIds }) {
    const folder = folderName(name);
    requireThat(folder, 'Choose a folder for Work All Night.');
    requireThat(!this.running.has(folder), 'This folder already has a Work All Night run.');
    const roster = this.roster(folder, issueIds);
    const id = randomUUID();
    this.plans.set(folder, { id, folder, issueIds: [...issueIds], basis: roster.map(identity) });
    return { id, finishLine, issues: roster.map(({ issue }) => publicIssue(issue)) };
  }

  async start(planId) {
    const plan = [...this.plans.values()].find(({ id }) => id === planId);
    requireThat(plan && !this.running.has(plan.folder), 'Preview the current Work All Night selection again.');
    await this.flows.service.projectStores?.refresh({ issueIds: plan.issueIds });
    requireThat(
      this.plans.get(plan.folder) === plan && !this.running.has(plan.folder),
      'Preview the current Work All Night selection again.'
    );
    const roster = this.roster(plan.folder, plan.issueIds);
    requireThat(
      roster.every((entry, index) => identity(entry) === plan.basis[index]),
      'The selected issues changed. Preview the selection again.'
    );
    this.plans.delete(plan.folder);
    return this.launch(plan, roster);
  }

  drafts() {
    return existsSync(this.draftPath) ? readJson(this.draftPath) : {};
  }

  projectView() {
    const reports = Object.values(this.reports()).filter((run) => run.project);
    const started = new Set(reports.map(({ id }) => id));
    return [...Object.values(this.drafts()).filter(({ id }) => !started.has(id)), ...reports].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  projectRun(id) {
    const run = this.projectView().find((entry) => entry.id === id);
    requireThat(run, 'Choose a saved overnight run.');
    return run;
  }

  projectAction(input) {
    const commands = {
      'project-night-save': () => this.saveDraft(input),
      'project-night-suggest': () => this.suggest(input),
      'project-night-start': () => this.startDraft(input.runId, input.revision),
      'project-night-stop': () => this.stopDraft(input.runId),
      'project-night-group': () => this.previewGroup(input.issueIds),
    };
    return commands[input.action]();
  }

  stopDraft(id) {
    this.projectRun(id);
    return this.stop(id);
  }

  previewGroup(issueIds) {
    const roster = this.roster(null, issueIds);
    return this.flows.groups.preview(
      {
        folder: roster[0].flow.folder,
        issueIds,
        acrossFolders: true,
      },
      []
    );
  }

  saveDraft({ runId, revision, issueIds, strategy }) {
    const drafts = this.drafts();
    const previous = this.editableDraft(runId, revision) || {};
    const basis = this.draftBasis(issueIds, strategy);
    const { id = randomUUID(), revision: savedRevision = 0 } = previous;
    const draft = {
      id,
      project: true,
      status: 'draft',
      issueIds,
      strategy,
      basis,
      revision: savedRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(this.flows.store.directory, { recursive: true });
    writeJson(this.draftPath, { ...drafts, [id]: draft });
    this.flows.service.flowChanges?.notify();
    return draft;
  }

  editableDraft(id, revision) {
    if (!id) return null;
    const run = this.projectRun(id);
    requireThat(run.status === 'draft' && run.revision === revision, 'This run changed. Reopen it before saving.');
    return run;
  }

  draftBasis(issueIds, strategy) {
    requireThat(strategies.has(strategy), 'Choose a grouping strategy.');
    requireThat(
      Array.isArray(issueIds) && issueIds.length <= 100 && new Set(issueIds).size === issueIds.length,
      'Choose up to 100 distinct issues.'
    );
    return issueIds.length ? this.independentBasis(issueIds) : [];
  }

  independentBasis(issueIds) {
    return this.selectRoster(null, issueIds).map((entry) => {
      this.flows.groups.requireIndependent(entry.issue.id);
      return identity(entry);
    });
  }

  async suggest({ issueIds, strategy }) {
    requireThat(strategies.has(strategy), 'Choose a grouping strategy.');
    const roster = this.roster(null, issueIds);
    const candidates = roster.filter(
      ({ issue, flow }) => strategy === 'different-blast-radii' || this.flows.groupEligible(issue, flow)
    );
    const details = candidates.map(({ issue, flow }) => ({
      ...publicIssue(issue),
      folder: flow.folder,
      target: deliveryTarget(flow).branch,
      storeId: issue.storeId,
      request: requestBlock(flow).data.wording,
    }));
    if (details.length < 2) return [];
    const output = await this.flows.folderSelection.recommend(strategy, details, []);
    const ids = new Set(details.map(({ id }) => id));
    return output
      .filter(({ id, reason }) => ids.has(id) && typeof reason === 'string')
      .map(({ id, reason }) => ({
        id,
        reason: redactValue(reason.slice(0, 1200)),
      }));
  }

  async startDraft(id, revision) {
    const draft = this.projectRun(id);
    requireThat(draft.status === 'draft' && draft.revision === revision, 'Review and save the current draft first.');
    await this.flows.service.projectStores?.refresh({ issueIds: draft.issueIds });
    const current = this.projectRun(id);
    requireThat(
      current.status === 'draft' && current.revision === revision && !this.running.has(id),
      'Review and save the current draft first.'
    );
    const roster = this.roster(null, current.issueIds);
    requireThat(
      roster.every((entry, index) => identity(entry) === current.basis[index]),
      'A selected issue changed. Review and save the draft again before starting.'
    );
    return this.launch(current, roster);
  }

  launch(plan, roster) {
    const run = {
      id: plan.id,
      folder: plan.folder,
      ...(plan.project && { project: true, strategy: plan.strategy }),
      finishLine,
      status: 'running',
      startedAt: new Date().toISOString(),
      issues: roster.map(({ issue }) => ({ ...publicIssue(issue), status: 'queued' })),
    };
    this.running.set(runKey(run), run);
    try {
      this.save(run);
    } catch (error) {
      this.running.delete(runKey(run));
      throw error;
    }
    void this.run(run, new Map(roster.map((entry) => [entry.issue.id, identity(entry)]))).catch((error) => {
      console.warn('Could not save the Work All Night report: ' + redactValue(error.message));
    });
    return run;
  }

  stop(folder) {
    const run = this.running.get(folder);
    if (!run) return Object.entries(this.reports()).find(([name]) => name === folder)?.[1];
    if (run.status === 'running') this.requestStop(run);
    return run;
  }

  requestStop(run) {
    run.status = 'stopping';
    this.save(run);
    const row = run.issues.find(({ status }) => status === 'running');
    if (!row || !this.owns(row.id, run.id)) return;
    const active = this.flows.active.get(row.id);
    if (active) this.flows.stop({ issueId: row.id }, { blockId: active.blockId });
  }

  close() {
    this.closed = true;
    for (const [folder, run] of this.running) {
      this.running.delete(folder);
      this.save(interrupted(run));
    }
  }

  async run(run, basis) {
    try {
      for (const row of run.issues) {
        if (!this.canAdvance(run)) break;
        await this.runIssue(run, row, basis.get(row.id));
      }
      if (!this.closed) this.finish(run);
    } finally {
      this.running.delete(runKey(run));
    }
  }

  canAdvance(run) {
    return run.status === 'running' && !this.closed;
  }

  finish(run) {
    for (const row of run.issues.filter(({ status }) => status === 'queued'))
      end(row, 'stopped', 'This issue did not start.', 'Start this issue when ready.');
    run.status = run.status === 'stopping' ? 'stopped' : 'finished';
    run.finishedAt = new Date().toISOString();
    this.save(run);
  }

  async runIssue(run, row, basis) {
    try {
      const [entry] = this.roster(run.folder, [row.id]);
      requireThat(identity(entry) === basis, 'This issue changed after Work All Night started.');
      const dependency = this.unmetDependency(entry.issue);
      if (dependency)
        return end(
          row,
          'paused',
          `Blocked by ${dependencyLabel(dependency)}.`,
          'Finish and verify the prerequisite first.'
        );
      this.owners.set(row.id, run);
      row.status = 'running';
      this.save(run);
      await this.runRoute(run, row);
    } catch (error) {
      end(row, 'paused', redactValue(error.message), 'Inspect the issue before continuing.');
    } finally {
      this.release(run, row);
    }
  }

  release(run, row) {
    if (this.owns(row.id, run.id)) this.owners.delete(row.id);
    if (!this.closed) this.save(run);
  }

  unmetDependency(issue) {
    const root = this.flows.service.root;
    const ids = ['open', 'closed', 'archive'].flatMap((location) =>
      listStoredIssues(root, location).map((path) => basename(path, '.md'))
    );
    const children = groupChildren(issue).map(({ id }) => this.flows.selected(id));
    const internal = new Set([issue.id, ...children.map(({ id }) => id)]);
    const references = new Set([issue, ...children].flatMap(({ content }) => issueDependencies(content, ids)));
    for (const dependencyId of references.difference(internal)) {
      const dependency = this.flows.selected(dependencyId);
      if (!this.dependencyDelivered(dependency)) return dependency;
    }
    return null;
  }

  dependencyDelivered(issue) {
    if (issue.closed && ['fixed', 'fixed-by'].includes(issue.closure?.reason)) return true;
    return Boolean(mergedDelivery(this.flows.read(issue)));
  }

  async runRoute(run, row) {
    while (this.canAdvance(run) && row.status === 'running') await this.advanceRoute(run, row);
    if (row.status === 'running')
      end(row, 'stopped', 'Work All Night was stopped.', 'Inspect and continue the saved issue when ready.');
  }

  readRoute(issueId) {
    this.requireRunAllowed(issueId);
    const issue = this.flows.selected(issueId);
    this.flows.groups.requireIndependent(issueId);
    requireThat(!issue.closed, 'The issue closed before this block could start.');
    const { entries } = this.flows.catalog.read();
    const flow = this.flows.read(issue, entries);
    this.flows.requireAvailableAction(issue, flow, 'play');
    return { issue, flow, entries };
  }

  requireRunAllowed(issueId) {
    const { service } = this.flows;
    service.serverControl?.allow('/api/flow-action', { action: 'play', issueId });
    service.ownServer();
  }

  async advanceRoute(run, row) {
    const { issue, flow, entries } = this.readRoute(row.id);
    const block = await this.flows.nextAutoplayBlock(issue, flow, entries);
    if (!this.canAdvance(run) || blockNeedsAttention(row, block)) return;
    this.requireRunAllowed(row.id);
    row.blockId = block.id;
    row.block = block.label;
    this.save(run);
    await this.runBlock(issue, flow, block, entries);
    if (this.canAdvance(run)) recordAttempt(row, block, this.flows.read(this.flows.selected(row.id), entries));
  }

  async runBlock(issue, flow, block, catalog) {
    requireThat(
      !(await this.flows.checkDefinition(issue, flow, block.id, catalog)),
      `${block.label} changed. Review its definition.`
    );
    if (block.kind === 'request') {
      await this.flows.refreshRequest(issue, flow, requestBlock(flow).data.wording, catalog, { keepPlaying: true });
      return;
    }
    await this.flows.start(issue, flow, { blockId: block.id, action: nextAction(block) }, catalog, 'play');
    await this.flows.active.get(issue.id)?.task;
  }
}
