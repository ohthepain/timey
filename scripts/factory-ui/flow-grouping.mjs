import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { digest, requireThat, writeJson } from './common.mjs';
import { closedIssueState } from './data.mjs';
import { requestData } from './flow-block-data.mjs';
import { mergedDelivery } from './merged-issue.mjs';
import { activeGroupRequest, requireDetachableSource } from './flow-group-scope.mjs';
import { flowWorkspace } from './flow-observer.mjs';
import { runOwnedOperation } from './stores/owned-operation.mjs';
import { sameOwner } from './stores/coordination.mjs';
import { issueAnnotations } from './issue-annotations.mjs';
import { groupProofRows } from './flow-group-proof.mjs';
import { issueHasActiveWork } from './issue-cleanup.mjs';
import { groupChildren, groupMaster, storedGroups } from './issue-group.mjs';
import { issueStorageDirectory, moveStoredIssue, updateStoredIssueMetadata } from './issue-report-storage.mjs';
import { afterReportWrite, registeredProjectStores } from './stores/report-access.mjs';
import { resolveFolderSettings } from './issue-folder-settings.mjs';
import { deliveryTarget } from './flow-block-data.mjs';

const previewLifetime = 10 * 60 * 1000;
const subIssueClosure = 'Sub-issue fixed by master issue';

function issueLink({ id, title, issueNumber }) {
  return { id, title, issueNumber };
}

function groupedHumanChecks(issue) {
  return (issue.human_checks ?? []).map(({ id, title, question, kind, blocks, instructions }) => ({
    originalId: id,
    check: {
      id: `group-${issue.id}-${digest(id).slice(0, 12)}`,
      title: `${issue.title}: ${title || question || id}`,
      kind,
      blocks,
      instructions,
      status: 'pending',
    },
  }));
}

function childRecord({ id, title, wording, fields, requestedProof, humanChecks, previousState }) {
  const links = humanChecks.map(({ originalId, check }) => ({ originalId, masterId: check.id }));
  return { id, title, wording, fields, requestedProof, previousState, ...(links.length && { humanChecks: links }) };
}

function detachedGroupMetadata(master, target, record = {}) {
  const detachedAt = new Date().toISOString();
  const checks = new Set(target.humanChecks?.map(({ masterId }) => masterId));
  const history = (master.human_checks ?? []).filter(({ id }) => checks.has(id));
  const children = master.issue_group.children.map((child) =>
    child.id === target.id ? { ...child, detachedAt, detach: { ...record, humanChecks: history } } : child
  );
  return {
    updated: detachedAt,
    issue_group: { ...master.issue_group, children },
    ...(checks.size && { human_checks: master.human_checks?.filter(({ id }) => !checks.has(id)) ?? [] }),
  };
}

function acceptedChildChecks(master, child, issue) {
  const ids = new Map(child.humanChecks?.map(({ originalId, masterId }) => [originalId, masterId]));
  return issue.human_checks?.map((check) => {
    if (!ids.has(check.id)) return check;
    const accepted = master.human_checks?.find(({ id }) => id === ids.get(check.id));
    requireThat(accepted?.status === 'passed', `The master needs a human result for ${check.title || check.id}.`);
    return { ...check, status: 'passed', result: accepted.result, revision: accepted.revision };
  });
}

function combinedWording(folder, children) {
  return [
    `# Group: ${folder}`,
    ...children.map(
      ({ id, issueNumber, title, wording, requestedProof }) =>
        `## ${issueNumber ? `#${issueNumber} ` : ''}${title}\n\nIssue ID: ${id}\n\n${wording}\n\nRequested proof:\n${requestedProof}`
    ),
  ].join('\n\n');
}

function isActiveBlocker({ type, label, cleared }) {
  return type === 'label' && label === 'blocked' && !cleared;
}

function hasQueuedChat(chatQueue) {
  return chatQueue?.operation || chatQueue?.activeTurn || chatQueue?.entries?.length;
}

export class FlowGrouping {
  constructor(flows) {
    this.flows = flows;
    this.service = flows.service;
    this.previews = join(flows.store.directory, 'group-previews');
    this.scopeChanges = new Map();
  }

  masterId(id, issues = this.flows.issues()) {
    return groupMaster(issues, id, closedIssueState(this.service.root))?.id ?? null;
  }

  requireIndependent(id) {
    const master = groupMaster(this.flows.issues(), id, closedIssueState(this.service.root));
    requireThat(!master, `This issue is a sub-issue of ${master?.title}. Work on the master instead.`);
  }

  candidate(issue, flow, issues) {
    const chatQueue = this.service.issueChats?.scheduler?.view(issue.id);
    return (
      this.flows.folderSelection.idle(issue, flow) &&
      !issue.issue_group &&
      !this.masterId(issue.id, issues) &&
      !this.flows.overnight?.owns(issue.id) &&
      !hasQueuedChat(chatQueue)
    );
  }

  snapshot(folder, ids) {
    requireThat(
      Array.isArray(ids) && ids.length >= 2 && ids.length <= 50 && new Set(ids).size === ids.length,
      'Choose between two and fifty different issues to group.'
    );
    const issues = this.flows.issues();
    const registryPath = join(this.service.root, '.issues/factory.json');
    const scheduled = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')).actions.filter((action) =>
          ['reserved', 'setup', 'running', 'blocked'].includes(action.status)
        )
      : [];
    return ids.map((id) => {
      const issue = issues.find((entry) => entry.id === id);
      requireThat(issue, 'A selected issue no longer exists. Review the group again.');
      const flow = this.flows.read(issue);
      requireThat(
        flow.folder === folder &&
          this.flows.groupEligible(issue, flow, undefined, issues) &&
          !scheduled.some((action) => action.issues.includes(id)),
        `${issue.title} cannot join this master. It must be open, idle, independent, and use this folder’s target branch. Review the group again.`
      );
      const request = requestData(flow);
      return {
        ...issueLink(issue),
        previousState: issue.state,
        wording: request.wording,
        fields: { ...request.fields },
        requestedProof: request.fields?.requestedProof || 'Demonstrate the behavior requested in the original issue.',
        humanChecks: groupedHumanChecks(issue),
        type: request.fields?.type ?? flow.routeType,
        reportHash: digest(issue.content),
        flowRevision: flow.revision,
        targetBranch: deliveryTarget(flow).branch,
        folderSettingsBasis: resolveFolderSettings(this.service.root, folder).basis,
      };
    });
  }

  checkCapture(grouping) {
    const { folder, children, basis } = grouping;
    requireThat(
      digest(
        JSON.stringify(
          this.snapshot(
            folder,
            children.map(({ id }) => id)
          )
        )
      ) === basis,
      'A selected issue changed. Review the combined request again.'
    );
  }

  writeCapture(grouping, write) {
    if (!grouping) return write();
    const lock = join(this.service.root, '.issues/factory.lock');
    requireThat(!existsSync(lock), 'Wait for the active queue operation, then create the master again.');
    mkdirSync(lock);
    try {
      this.checkCapture(grouping);
      return write();
    } finally {
      rmdirSync(lock);
    }
  }

  action(input, reasoning = []) {
    if (['folder-detach-blocked', 'folder-reattach'].includes(input.action)) return this.changeScopeAction(input);
    if (input.action === 'folder-detach') return this.manualDetach(input);
    if (input.action === 'folder-group-create') return this.create(input);
    requireThat(input.action === 'folder-group-preview', 'Choose a grouping action.');
    return this.preview(input, reasoning);
  }

  manualDetach(input) {
    return input.masterId ? this.removeMaster(input) : this.detach(input);
  }

  changeScopeAction(input) {
    return this.changeBlockedScope(input, { reattach: input.action === 'folder-reattach' }).then(() =>
      this.flows.view(input.issueId)
    );
  }

  preview({ folder, issueIds }, reasoning) {
    const stores = registeredProjectStores(this.service.root);
    return afterReportWrite(stores?.assertSameStorage(issueIds), () =>
      this.previewCurrent(folder, issueIds, reasoning)
    );
  }

  previewCurrent(folder, issueIds, reasoning) {
    requireThat(typeof folder === 'string' && folder.trim(), 'Choose an issue folder.');
    const candidates = this.snapshot(folder, issueIds);
    const wording = combinedWording(folder, candidates);
    requireThat(wording.length <= 24000, 'The combined request is too long. Select fewer issues.');
    const [first] = candidates;
    const type = candidates.every((item) => item.type === first.type) ? first.type : 'feature';
    const id = randomUUID();
    const grouping = {
      folder,
      children: candidates.map(childRecord),
      humanChecks: candidates.flatMap((candidate) => candidate.humanChecks.map(({ check }) => check)),
      reasoning,
      basis: digest(JSON.stringify(candidates)),
    };
    mkdirSync(this.previews, { recursive: true });
    for (const name of readdirSync(this.previews)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.previews, name);
      if ((statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) + previewLifetime <= Date.now())
        rmSync(path, { force: true });
    }
    writeJson(join(this.previews, `${id}.json`), { grouping, type, expires: Date.now() + previewLifetime });
    return { id, wording };
  }

  async create({ previewId, wording, requestId }) {
    requireThat(
      typeof previewId === 'string' && /^[a-f0-9-]{36}$/.test(previewId),
      'Review a current combined request first.'
    );
    const path = join(this.previews, `${previewId}.json`);
    const preview = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    requireThat(preview && preview.expires > Date.now(), 'Review a current combined request first.');
    const stores = registeredProjectStores(this.service.root);
    const ids = preview.grouping.children.map((child) => child.id);
    await stores?.refresh({ issueIds: ids });
    return afterReportWrite(stores?.assertSameStorage(ids), async (storage) => {
      const result = await this.flows.capture(
        {
          requestId,
          description: wording,
          folder: preview.grouping.folder,
          type: preview.type,
        },
        preview.grouping,
        storage
      );
      if (result.deleted) return result;
      await this.resetChildren(result.issue.id);
      return this.flows.view(result.issue.id);
    });
  }

  async resetChildren(masterId) {
    const master = this.flows.selected(masterId);
    for (const child of groupChildren(master)) {
      const issue = this.flows.selected(child.id);
      if (issue.state === 'backlog') continue;
      requireThat(
        !issue.closed && !issueHasActiveWork(this.service, issue.id),
        `Wait for ${issue.title} to be idle before resetting its status.`
      );
      const shared = this.service.sharedIssues?.acquire(issue, true);
      await updateStoredIssueMetadata(this.service.root, issue, {
        state: 'backlog',
        updated: new Date().toISOString(),
      });
      if (shared) this.service.sharedIssues.checkpoint(issue.id, 'Moved into master issue', shared);
    }
  }

  async removeMaster({ issueId, subIssueId, revision, masterId, masterRevision }) {
    requireThat(
      issueId === subIssueId && this.masterId(issueId) === masterId,
      'The master changed. Review this issue again.'
    );
    requireThat(
      revision === this.flows.read(this.flows.selected(issueId)).revision,
      'The issue changed. Review it again.'
    );
    await this.detach({ issueId: masterId, subIssueId, revision: masterRevision });
    return this.flows.view(issueId);
  }

  async detach({ issueId, subIssueId, revision }) {
    if ((await issueAnnotations(this.service).list(subIssueId)).some(isActiveBlocker)) {
      await this.changeBlockedScope({ issueId, subIssueId, revision });
      return this.flows.view(issueId);
    }
    const master = this.flows.selected(issueId);
    const flow = this.flows.read(master);
    requireThat(this.canDetach(master), 'Wait for the master to be idle before detaching a sub-issue.');
    requireThat(revision === flow.revision, 'The master changed. Review its sub-issues again.');
    const target = groupChildren(master).find(({ id }) => id === subIssueId);
    requireThat(target, 'Choose an attached sub-issue.');
    this.flows.pause(
      issueId,
      groupChildren(master).length === 1
        ? 'The master has no attached sub-issues. Review its scope.'
        : 'A sub-issue was detached.'
    );
    const shared = this.service.sharedIssues?.acquire(master, true);
    await this.flows.store.save(flow, revision);
    const changes = detachedGroupMetadata(this.withSavedScope(master, flow), target);
    activeGroupRequest({ ...master, ...changes }, flow);
    await updateStoredIssueMetadata(this.service.root, master, changes);
    if (shared) this.service.sharedIssues.checkpoint(issueId, 'Sub-issue detached', shared);
    return this.flows.view(issueId);
  }

  withSavedScope(master, flow) {
    const children = master.issue_group.children;
    if (children.every(({ wording }) => typeof wording === 'string')) return master;
    const original = requestData(flow).wording;
    const restored = children.map((child) => {
      if (typeof child.wording === 'string') return child;
      const match = original.split(`\n\nIssue ID: ${child.id}\n\n`);
      const end = match[1]?.indexOf(`\n\nRequested proof:\n${child.requestedProof}`);
      requireThat(match.length === 2 && end > 0, 'The original child scope is unavailable. Review this group.');
      return { ...child, wording: match[1].slice(0, end) };
    });
    return { ...master, issue_group: { ...master.issue_group, children: restored } };
  }

  detailSources(block, definition) {
    return new Map((block.declaredDetails ?? definition?.details ?? []).map(({ key, source }) => [key, source]));
  }

  projectDetails(block, definition, details, { scope, fields }) {
    const sources = this.detailSources(block, definition);
    const values = new Map(Object.entries(fields).map(([key, value]) => ['Request.' + key, value]));
    values.set('Request.wording', scope);
    values.set('issue.content', scope);
    for (const detail of details) {
      const source = sources.get(detail.key);
      if (values.has(source)) detail.value = values.get(source);
    }
    if (block.kind === 'request') details.find(({ key }) => key === 'wording').value = scope;
  }

  requireScopeStable(id) {
    requireThat(!this.scopeChanges.has(id), 'Wait for the master scope change to finish.');
  }

  requireChildren(issue) {
    requireThat(
      !issue.issue_group || groupChildren(issue).length,
      'Attach a sub-issue before resuming the empty master.'
    );
  }

  waitForScope(id) {
    return this.scopeChanges.get(id)?.catch(() => {});
  }

  activeScopeBlock(flow, active) {
    const block = flow.blocks.find(({ id }) => id === active?.blockId);
    return block?.attempts.some(({ id, status }) => id === active.attemptId && status === 'running') ? block : null;
  }

  canDetachBlocked(master, flow, target) {
    if (!this.openScope(master, flow)) return false;
    const active = this.flows.active.get(master.id);
    return active ? this.canDetachDuringAttempt(flow, active, target) : this.canDetach(master);
  }

  openScope(master, flow) {
    return ![master.closed, flow.closing, mergedDelivery(flow), this.flows.overnight?.owns(master.id)].some(Boolean);
  }

  canDetachDuringAttempt(flow, active, target) {
    const block = this.activeScopeBlock(flow, active);
    if (!block) return false;
    if (block.kind === 'request') return true;
    const scope = block.attempts.find(({ id }) => id === active.attemptId).workIssueIds;
    return Array.isArray(scope) && !scope.includes(target);
  }

  scopeView(issueId, attemptId) {
    const active = this.flows.active.get(issueId);
    requireThat(
      active?.attemptId === attemptId && !active.controller.signal.aborted,
      'The master run no longer owns this operation.'
    );
    const master = this.flows.selected(issueId);
    return { revision: this.flows.read(master).revision, attached: groupChildren(master).map(issueLink) };
  }

  detachFromRun(issueId, attemptId, { subIssueId, revision }) {
    const active = this.flows.active.get(issueId);
    requireThat(
      active?.attemptId === attemptId && !active.controller.signal.aborted,
      'The master run no longer owns this operation.'
    );
    const { issue_group } = this.flows.selected(issueId);
    requireThat(issue_group, 'Only the master run can detach its own sub-issue.');
    return this.changeBlockedScope(
      { issueId, subIssueId, revision },
      { attemptId, actor: { kind: 'issue', id: issueId } }
    ).then(() => this.scopeView(issueId, attemptId));
  }

  changeBlockedScope(input, options = {}) {
    this.requireScopeStable(input.issueId);
    const task = Promise.resolve().then(() => this.applyScopeChange(input, options));
    this.scopeChanges.set(input.issueId, task);
    return task.finally(() => this.scopeChanges.delete(input.issueId));
  }

  async applyScopeChange(input, options) {
    const context = await this.prepareScopeChange(input, options);
    if (!context) return;
    if (this.service.projectStores && !context.active) return this.changeIdleSharedScope(context);
    return this.changeLocalScope(context);
  }

  async prepareScopeChange({ issueId, subIssueId, revision }, options = {}) {
    this.allowScopeChange(issueId);
    const master = this.flows.selected(issueId);
    const flow = this.flows.read(master);
    const target = master.issue_group?.children.find(({ id }) => id === subIssueId);
    requireThat(target, 'Choose a sub-issue of this master.');
    if (Boolean(options.reattach) !== Boolean(target.detachedAt)) return;
    requireThat(revision === flow.revision, 'The master changed. Review its sub-issues again.');
    const blocker = options.reattach ? null : await this.childBlocker(subIssueId);
    const active = this.flows.active.get(issueId);
    this.requireRunOwner(options.attemptId, active);
    const context = { master, flow, target, active, blocker, ...options };
    this.checkScopeChange(context);
    return context;
  }

  allowScopeChange(issueId) {
    this.service.serverControl?.allow('/api/flow-action', { issueId, action: 'folder-detach-blocked' });
  }

  async childBlocker(issueId) {
    const blocker = (await issueAnnotations(this.service).list(issueId)).find(isActiveBlocker);
    requireThat(blocker, 'The sub-issue needs an active blocker.');
    return blocker;
  }

  requireRunOwner(attemptId, active) {
    requireThat(!attemptId || active?.attemptId === attemptId, 'The master run no longer owns this operation.');
  }

  changeIdleSharedScope(context) {
    const { master, flow, reattach } = context;
    return runOwnedOperation(this.flows, {
      issue: master,
      flow,
      label: this.scopeLabel(reattach),
      operation: reattach ? 'reattach-child' : 'detach-blocked-child',
      run: ({ flow: admitted }) => {
        this.requireCurrentMaster(master);
        this.checkScopeChange(context, true);
        return this.saveScopeChange({ ...context, flow: admitted });
      },
    });
  }

  requireCurrentMaster(master) {
    const current = this.flows.selected(master.id);
    requireThat(master.content === current.content, 'The master changed. Review its sub-issues again.');
    return current;
  }

  requireCurrentAttempt({ master, active }) {
    requireThat(
      active === this.flows.active.get(master.id),
      'The master Work state changed. Retry with its current scope.'
    );
  }

  async changeLocalScope(context) {
    const { master, flow } = context;
    await this.requireCurrentScopeClaim(context);
    this.requireCurrentMaster(master);
    const saved = this.flows.read(master);
    requireThat(saved.revision === flow.revision, 'The master changed. Review its sub-issues again.');
    this.requireCurrentAttempt(context);
    this.checkScopeChange({ ...context, flow: saved });
    await this.advanceScopeRevision(saved);
    this.requireCurrentAttempt(context);
    const current = this.requireCurrentMaster(master);
    const latest = this.flows.read(current);
    this.checkScopeChange({ ...context, flow: latest });
    await this.saveScopeChange({ ...context, master: current, flow: latest });
  }

  async requireCurrentScopeClaim({ master, active }) {
    const stores = this.service.projectStores;
    if (!stores) return;
    const claim = await stores.coordination.get('claims/' + master.id);
    requireThat(sameOwner(claim?.value, active?.storeOwner), 'The master Work claim changed.');
  }

  advanceScopeRevision(flow) {
    const { issueId, revision } = flow;
    if (!this.service.projectStores) return this.flows.store.save(flow, revision);
    this.flows.store.stage(flow, revision);
    return this.flows.store.flush(issueId, { drain: false });
  }

  checkScopeChange({ master, flow, target, active, reattach }, owned = false) {
    requireThat(this.openScope(master, flow), 'Choose an open master before changing its scope.');
    if (reattach) return this.requireReattachable(master, target, owned);
    requireThat(
      owned || this.canDetachBlocked(master, flow, target.id),
      'The master must be in Request, idle, or running Work scoped to the remaining children.'
    );
    requireDetachableSource(flow, flowWorkspace(this.service, flow), target.id, active);
  }

  requireReattachable(master, target, owned) {
    const child = this.flows.selected(target.id);
    const idle = owned || this.canDetach(master);
    requireThat(
      idle && this.candidate(child, this.flows.read(child), this.flows.issues()),
      'The master and sub-issue must be idle and the sub-issue must be open and independent.'
    );
  }

  scopeLabel(reattach) {
    return reattach ? 'Sub-issue reattached' : 'Blocked sub-issue detached';
  }

  async saveScopeChange({ master, flow, target, blocker, actor, reattach }) {
    const scoped = this.withSavedScope(master, flow);
    const changes = reattach
      ? this.reattachedMetadata(scoped, target)
      : this.blockedMetadata(scoped, flow, target, blocker, actor);
    activeGroupRequest({ ...master, ...changes }, flow);
    const shared = this.service.sharedIssues?.acquire(master, true);
    await updateStoredIssueMetadata(this.service.root, master, changes);
    this.pauseEmpty(master.id, changes.issue_group);
    const summary = this.scopeLabel(reattach);
    if (shared) this.service.sharedIssues.checkpoint(master.id, summary, shared);
    this.service.flowChanges?.notify('flow', master.id);
    return { summary };
  }

  blockedMetadata(master, flow, target, blocker, actor) {
    return detachedGroupMetadata(master, target, {
      actor: actor ?? { kind: 'user', id: userInfo().username },
      annotationId: blocker.id,
      reason: blocker.note || 'The sub-issue is blocked.',
      revision: flow.revision,
    });
  }

  pauseEmpty(id, group) {
    if (!groupChildren({ issue_group: group }).length)
      this.flows.pause(id, 'The master has no attached sub-issues. Review its scope.');
  }

  reattachedMetadata(master, target) {
    const child = this.flows.selected(target.id);
    const checks = groupedHumanChecks(child);
    const restored = childRecord({ ...target, previousState: child.state, humanChecks: checks });
    return {
      updated: new Date().toISOString(),
      issue_group: {
        ...master.issue_group,
        children: master.issue_group.children.map((entry) =>
          entry.id === target.id
            ? {
                ...restored,
                previousDetaches: [...(entry.previousDetaches ?? []), { ...entry.detach, at: entry.detachedAt }],
              }
            : entry
        ),
      },
      human_checks: [...(master.human_checks ?? []), ...checks.map(({ check }) => check)],
    };
  }

  canDetach(issue) {
    return !issue.closed && !issueHasActiveWork(this.service, issue.id) && !this.flows.overnight?.owns(issue.id);
  }

  masterView(issue, masterId) {
    const master = this.flows.issues(masterId)[0];
    if (!master) return { id: masterId, title: masterId, canDetach: false };
    return {
      ...issueLink(master),
      revision: this.flows.read(master).revision,
      canDetach: !issue.closed && this.canDetach(master),
    };
  }

  view(issue, flow, issues) {
    const { closure } = issue;
    const masterId = closure?.fixed_by ?? this.masterId(issue.id, issues);
    const formerMasters = [...issues, ...this.archivedGroups()].filter(
      (entry) => entry.id !== masterId && entry.issue_group?.children?.some((child) => child.id === issue.id)
    );
    const children = groupChildren(issue);
    if (!masterId && !formerMasters.length && !children.length && !issue.issue_group) return undefined;
    const proofRows = groupProofRows(flow, undefined, {}, this.service.root);
    const canDetach = this.canDetach(issue);
    return {
      ...(masterId && { master: this.masterView(issue, masterId) }),
      formerMasters: formerMasters.map(issueLink),
      ...this.groupSettings(issue, canDetach),
      children: children.map((child) =>
        this.childView(child, issues, proofRows.get(child.id), canDetach, this.canDetachBlocked(issue, flow, child.id))
      ),
    };
  }

  groupSettings(issue, canDetach) {
    const { reasoning = [], children = [] } = issue.issue_group ?? {};
    return {
      reasoning,
      detachedChildren: children.filter(({ detachedAt }) => detachedAt).map(issueLink),
      canReattach: canDetach && Boolean(issue.issue_group),
    };
  }

  childView({ wording: _wording, fields: _fields, ...child }, issues, proof, canDetach, canDetachBlocked) {
    const current = issues.find(({ id }) => id === child.id);
    return {
      ...child,
      ...issueLink(current ?? child),
      canDetach,
      canDetachBlocked,
      ...this.childProof(proof),
    };
  }

  childProof({
    status,
    observation,
    nextAction = 'Continue on the master to check this request, or detach it to work separately.',
  } = {}) {
    const values = status ? { proof: { status, observation } } : {};
    if (status !== 'passed') values.nextAction = nextAction;
    return values;
  }

  archivedGroups() {
    const { root } = this.service;
    const archive = issueStorageDirectory(root, 'archive');
    const modified = statSync(archive, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (this.archived?.modified !== modified) this.archived = { modified, groups: storedGroups(root, 'archive') };
    return this.archived.groups;
  }

  finish(master) {
    if (!master.closed || master.closure?.reason !== 'fixed') return;
    const children = groupChildren(master);
    const next = (index) =>
      index < children.length
        ? afterReportWrite(this.closeChild(master, children[index]), () => next(index + 1))
        : undefined;
    return next(0);
  }

  closeChild(master, child) {
    const { id } = child;
    const issue = this.flows.selected(id);
    const { root, sharedIssues } = this.service;
    if (issue.closed) {
      requireThat(
        issue.closure?.reason === 'fixed-by' && issue.closure?.fixed_by === master.id,
        `${issue.title} was closed separately. Reconcile the sub-issue report.`
      );
      if (issue.location === 'open') return this.finishChildPublication(issue);
      return;
    }
    requireThat(!issueHasActiveWork(this.service, id), `Wait for ${issue.title} to be idle before closing the group.`);
    const shared = sharedIssues?.acquireGroupClosure(issue, subIssueClosure);
    const at = master.closure.at;
    const reason = `Fixed by ${master.issueNumber ? '#' + master.issueNumber : master.id}. See the master’s accepted result for proof.`;
    const state = closedIssueState(root);
    return afterReportWrite(
      updateStoredIssueMetadata(root, issue, {
        state,
        updated: at,
        closure: { reason: 'fixed-by', label: 'Fixed by', details: reason, at, actor: 'human', fixed_by: master.id },
        ...(issue.human_checks && { human_checks: acceptedChildChecks(master, child, issue) }),
        lifecycle_history: [
          ...(issue.lifecycle_history ?? []),
          { state, outcome: 'completed', actor: 'human', reason, at },
        ],
      }),
      () => this.finishChildPublication(issue, shared)
    );
  }

  finishChildPublication(issue, context) {
    const { root, sharedIssues } = this.service;
    if (!sharedIssues) return moveStoredIssue(root, issue.id, 'open', 'closed');
    const publication = sharedIssues.publishGroupClosure(issue, subIssueClosure, context);
    requireThat(
      publication?.status === 'published',
      `Publish the pending closure for ${issue.title}, then retry closing the group.`
    );
  }
}
