import { orderedMasterChildren, sequentialMaster } from './sequential-master.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { digest, requireThat, writeJson } from './common.mjs';
import { closedIssueState } from './data.mjs';
import { deliveryTarget, invalidateBlocks, requestBlock, requestData } from './flow-block-data.mjs';
import { mergedDelivery } from './merged-issue.mjs';
import { activeGroupRequest, childRequestSection, requireDetachableSource } from './flow-group-scope.mjs';
import { flowWorkspace } from './flow-observer.mjs';
import { runOwnedOperation } from './stores/owned-operation.mjs';
import { sameOwner } from './stores/coordination.mjs';
import { issueAnnotations } from './issue-annotations.mjs';
import { groupProofRows } from './flow-group-proof.mjs';
import { issueHasActiveWork } from './issue-cleanup.mjs';
import { groupChildren, groupMaster, storedGroups, wasDetachedByMasterRun } from './issue-group.mjs';
import {
  issueStorageDirectory,
  moveStoredIssue,
  updateStoredGroup,
  updateStoredIssueMetadata,
} from './issue-report-storage.mjs';
import { afterReportWrite, registeredProjectStores } from './stores/report-access.mjs';
import { requireIssueFolder, resolveFolderSettings } from './issue-folder-settings.mjs';
import { isInvestigation } from './investigation-records.mjs';

const previewLifetime = 10 * 60 * 1000;
const subIssueClosure = 'Sub-issue fixed by master issue';
const scopeOperations = {
  'folder-attach': { label: 'Sub-issue attached', operation: 'attach-child' },
  'folder-reattach': { label: 'Sub-issue reattached', operation: 'reattach-child' },
  'folder-detach-blocked': { label: 'Blocked sub-issue detached', operation: 'detach-blocked-child' },
};

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

  snapshot(folder, ids, acrossFolders = false) {
    requireThat(
      Array.isArray(ids) && ids.length >= 2 && ids.length <= 50 && new Set(ids).size === ids.length,
      'Choose between two and fifty different issues to group.'
    );
    const candidates = this.currentCandidates(folder, ids, this.flows.issues(), acrossFolders);
    requireThat(
      candidates.every(({ type }) => (type === 'investigation') === (candidates[0].type === 'investigation')),
      'A master cannot mix investigative and non-investigative sub-issues.'
    );
    return candidates;
  }

  currentCandidates(folder, ids, issues = this.flows.issues(), acrossFolders = false) {
    const registryPath = join(this.service.root, '.issues/factory.json');
    const scheduled = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')).actions.filter((action) =>
          ['reserved', 'setup', 'running', 'blocked'].includes(action.status)
        )
      : [];
    const target = acrossFolders && resolveFolderSettings(this.service.root, folder).values.branch;
    return ids.map((id) => {
      const issue = issues.find((entry) => entry.id === id);
      requireThat(issue, 'A selected issue no longer exists. Review the group again.');
      const flow = this.flows.read(issue);
      const location = { folder, acrossFolders, target };
      this.requireCandidateLocation(issue, flow, location);
      requireThat(
        this.flows.groupEligible(issue, flow, undefined, issues) &&
          !scheduled.some((action) => action.issues.includes(id)),
        `${issue.title} cannot join this master. It must be open, idle, independent, and use its folder’s target branch. Review the group again.`
      );
      const request = requestData(flow);
      return {
        ...issueLink(issue),
        previousState: issue.state,
        wording: request.wording,
        fields: { ...request.fields },
        requestedProof: request.fields?.requestedProof || 'Demonstrate the behavior requested in the original issue.',
        humanChecks: groupedHumanChecks(issue),
        type: request.fields?.type || flow.routeType,
        reportHash: digest(issue.content),
        flowRevision: flow.revision,
        targetBranch: deliveryTarget(flow).branch,
        folderSettingsBasis: resolveFolderSettings(this.service.root, flow.folder).basis,
      };
    });
  }

  requireCandidateLocation(issue, flow, { folder, acrossFolders, target }) {
    if (acrossFolders) {
      this.flows.requireAvailableAction(issue, flow, 'play');
      requireThat(deliveryTarget(flow).branch === target, `${issue.title} uses a different target branch.`);
    } else {
      requireThat(flow.folder === folder, `${issue.title} is no longer in this folder. Review the group again.`);
    }
  }

  checkCapture(grouping) {
    const { folder, children, basis, acrossFolders } = grouping;
    requireThat(
      digest(
        JSON.stringify(
          this.snapshot(
            folder,
            children.map(({ id }) => id),
            acrossFolders
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
    const methods = {
      'folder-detach-blocked': () => this.changeScopeAction(input),
      'folder-reattach': () => this.changeScopeAction(input),
      'folder-attach': () => this.changeScopeAction(input),
      'folder-detach': () => this.manualDetach(input),
      'folder-reorder': () => this.reorder(input),
      'folder-group-create': () => this.create(input),
      'folder-group-preview': () => this.preview(input, reasoning),
    };
    requireThat(Object.hasOwn(methods, input.action), 'Choose a grouping action.');
    return methods[input.action]();
  }

  canReorder(issue, flow) {
    if (!sequentialMaster(issue) || !this.canDetach(issue)) return false;
    return this.idleSequence(issue.id, flow);
  }

  idleSequence(id, flow) {
    return !mergedDelivery(flow) && !['playing', 'waiting'].includes(this.flows.autoplay.get(id)?.mode);
  }

  async reorder({ issueId, issueIds, revision }) {
    const issue = this.flows.selected(issueId);
    const flow = await this.flows.actionFlow(issue, { action: 'folder-reorder' });
    this.requireScopeStable(issueId);
    requireThat(this.canReorder(issue, flow), 'Wait for the Sequential master to be idle before reordering.');
    requireThat(flow.revision === revision, 'The master changed. Refresh its order before reordering.');
    const current = new Set(groupChildren(issue).map(({ id }) => id));
    requireThat(
      Array.isArray(issueIds) &&
        issueIds.length === current.size &&
        new Set(issueIds).size === current.size &&
        issueIds.every((id) => current.has(id)),
      'Order all currently attached sub-issues.'
    );
    flow.sequentialOrder = issueIds;
    await this.flows.store.save(flow, revision);
    return this.flows.view(issueId);
  }

  async requireSequentialChild(child) {
    const blocker = (await issueAnnotations(this.service).list(child.id)).find(isActiveBlocker);
    requireThat(!blocker, child.title + ': ' + (blocker?.note || 'This sub-issue is blocked.'));
  }

  manualDetach(input) {
    return input.masterId ? this.removeMaster(input) : this.detach(input);
  }

  changeScopeAction(input) {
    return this.changeBlockedScope(input, { operation: input.action }).then(() => this.flows.view(input.issueId));
  }

  preview({ folder, issueIds, strategy, acrossFolders }, reasoning) {
    const stores = registeredProjectStores(this.service.root);
    return afterReportWrite(stores?.assertSameStorage(issueIds), () =>
      this.previewCurrent(folder, issueIds, reasoning, strategy, acrossFolders)
    );
  }

  previewCurrent(folder, issueIds, reasoning, strategy, acrossFolders) {
    requireThat(typeof folder === 'string' && folder.trim(), 'Choose an issue folder.');
    const candidates = this.snapshot(folder, issueIds, acrossFolders);
    const wording = [`# Group: ${folder}`, ...candidates.map(childRequestSection)].join('\n\n');
    requireThat(wording.length <= 24000, 'The combined request is too long. Select fewer issues.');
    const [first] = candidates;
    const type = candidates.every((item) => item.type === first.type) ? first.type : 'feature';
    const sequential = this.sequentialStrategy(strategy, type);
    const id = randomUUID();
    const grouping = {
      folder,
      acrossFolders,
      investigative: type === 'investigation',
      ...sequential,
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

  sequentialStrategy(strategy, type) {
    if (strategy !== 'sequential') return {};
    requireThat(type !== 'investigation', 'Sequential masters require implementation issues.');
    return { sequential: true };
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
    await stores?.refresh();
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

  assertGroupedMove(issueId, subIssueId) {
    requireThat(this.service.projectStores, 'This Issue Store does not support an atomic move of a sub-issue.');
    requireThat(
      this.masterId(subIssueId) === issueId,
      'The source master changed. Refresh before moving the sub-issue.'
    );
  }

  async moveGroupedIssue(input) {
    const { issueId, subIssueId, destinationMaster } = input;
    this.assertGroupedMove(issueId, subIssueId);
    await this.lockScopeChanges([issueId, subIssueId, destinationMaster].filter(Boolean), () =>
      this.applyGroupedMove(input)
    );
    return this.flows.view(destinationMaster ?? subIssueId);
  }

  requireMoveMaster(id, revision) {
    const issue = this.flows.selected(id);
    const flow = this.flows.read(issue);
    requireThat(issue.issue_group, 'Choose a master issue.');
    requireThat(
      this.openScope(issue, flow) && this.flows.folderSelection.idle(issue, flow),
      'Wait for the master to be idle before moving a sub-issue.'
    );
    requireThat(flow.revision === revision, 'The master changed. Refresh before moving the sub-issue.');
    return { issue, flow };
  }

  async applyGroupedMove(input) {
    const { issueId, subIssueId, revision, destinationMaster } = input;
    const source = this.requireMoveMaster(issueId, revision);
    const child = this.flows.selected(subIssueId);
    const childFlow = this.flows.read(child);
    const record = groupChildren(source.issue).find(({ id }) => id === subIssueId);
    requireThat(record, 'Choose an attached sub-issue.');
    requireThat(this.flows.folderSelection.idle(child, childFlow), 'Choose an open, idle sub-issue.');
    const changes = detachedGroupMetadata(this.withSavedScope(source.issue, source.flow), record);
    activeGroupRequest({ ...source.issue, ...changes }, source.flow);
    const destination = destinationMaster
      ? this.transferDestination(input, source.issue, changes, child)
      : this.folderDestination(input.folder, child, childFlow);
    await this.saveGroupedMove({ ...source, changes }, destination, child);

    this.flows.pause(source.issue.id, 'A sub-issue was moved.');
    if (destination.flow) this.flows.pause(destination.issue.id, 'A sub-issue was attached.');
    this.service.flowChanges?.notify('flow', source.issue.id);
    this.service.flowChanges?.notify('flow', destination.issue.id);
  }

  async saveGroupedMove(source, destination, child) {
    const updates = [source, destination];
    if (destination.issue.id !== child.id) updates.push({ issue: child });
    for (const { flow } of updates.filter(({ flow }) => flow)) invalidateBlocks(flow, new Set([requestBlock(flow).id]));
    await updateStoredGroup(this.service.root, updates);
  }

  transferDestination(input, source, changes, child) {
    const { destinationMaster, destinationRevision } = input;
    requireThat(destinationMaster !== source.id, 'Choose a different master.');
    const { issue, flow } = this.requireMoveMaster(destinationMaster, destinationRevision);
    const issues = this.flows.issues().map((entry) => (entry.id === source.id ? { ...entry, ...changes } : entry));
    const existing = issue.issue_group.children.find(({ id }) => id === child.id);
    const candidate = this.requireCompatibleChild(issue, flow, child.id, 'folder-attach', issues);
    const next = existing
      ? this.reattachedMetadata(this.withSavedScope(issue, flow), existing)
      : this.attachedMetadata(this.withSavedScope(issue, flow), candidate);
    activeGroupRequest({ ...issue, ...next }, flow);
    return { issue, flow, changes: next };
  }

  folderDestination(folder, issue, flow) {
    requireThat(!flow.folderLocked || flow.folder === folder, 'This issue is protected from moves into folders.');
    const target = requireIssueFolder(this.service.root, folder);
    return { issue, changes: { folder_id: target.id } };
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
    const changes = detachedGroupMetadata(this.withSavedScope(master, flow), target);
    activeGroupRequest({ ...master, ...changes }, flow);
    this.flows.pause(
      issueId,
      groupChildren(master).length === 1
        ? 'The master has no attached sub-issues. Review its scope.'
        : 'A sub-issue was detached.'
    );
    const shared = this.service.sharedIssues?.acquire(master, true);
    invalidateBlocks(flow, new Set([requestBlock(flow).id]));
    await this.flows.store.save(flow, revision);
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
    const ids = ['folder-attach', 'folder-reattach'].includes(options.operation)
      ? new Set([input.issueId, input.subIssueId])
      : new Set([input.issueId]);
    return this.lockScopeChanges(ids, () => this.applyScopeChange(input, options));
  }

  lockScopeChanges(ids, run) {
    for (const id of ids) this.requireScopeStable(id);
    const task = Promise.resolve().then(run);
    for (const id of ids) this.scopeChanges.set(id, task);
    return task.finally(() => {
      for (const id of ids) this.scopeChanges.delete(id);
    });
  }

  async applyScopeChange(input, options) {
    const context = await this.prepareScopeChange(input, options);
    if (!context) return;
    if (this.service.projectStores && !context.active) return this.changeIdleSharedScope(context);
    return this.changeLocalScope(context);
  }

  async prepareScopeChange({ issueId, subIssueId, revision }, { operation = 'folder-detach-blocked', ...options }) {
    this.allowScopeChange(issueId);
    if (operation === 'folder-attach') await this.service.projectStores?.assertSameStorage([issueId, subIssueId]);
    const master = this.flows.selected(issueId);
    const flow = this.flows.read(master);
    const target = this.scopeTarget(master, subIssueId, operation);
    if (!target) return;
    requireThat(revision === flow.revision, 'The master changed. Review its sub-issues again.');
    const blocker = operation === 'folder-detach-blocked' ? await this.childBlocker(subIssueId) : null;
    const active = this.flows.active.get(issueId);
    this.requireRunOwner(options.attemptId, active);
    const context = { master, flow, target, active, blocker, operation, ...options };
    this.checkScopeChange(context);
    return context;
  }

  scopeTarget(master, subIssueId, operation) {
    requireThat(master.issue_group, 'Choose a master issue.');
    const target = master.issue_group.children.find(({ id }) => id === subIssueId);
    if (operation === 'folder-attach') return this.newScopeTarget(target, subIssueId);
    requireThat(target, 'Choose a sub-issue of this master.');
    return (operation === 'folder-reattach') === Boolean(target.detachedAt) ? target : null;
  }

  newScopeTarget(target, subIssueId) {
    requireThat(!target?.detachedAt, 'Use Attach again for a detached sub-issue.');
    return target ? null : { id: subIssueId };
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
    const { master, flow, operation } = context;
    return runOwnedOperation(this.flows, {
      issue: master,
      flow,
      ...scopeOperations[operation],
      run: async ({ flow: admitted }) => {
        this.requireCurrentMaster(master);
        this.checkScopeChange({ ...context, flow: admitted }, true);
        const saved = operation === 'folder-attach' ? await this.advanceScopeRevision(admitted, true) : admitted;
        return this.saveScopeChange({ ...context, flow: saved }, true);
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
    await this.advanceScopeRevision(saved, context.operation === 'folder-attach');
    this.requireCurrentAttempt(context);
    const current = this.requireCurrentMaster(master);
    const latest = this.flows.read(current);
    await this.saveScopeChange({ ...context, master: current, flow: latest });
  }

  async requireCurrentScopeClaim({ master, active }) {
    const stores = this.service.projectStores;
    if (!stores) return;
    const claim = await stores.coordination.get('claims/' + master.id);
    requireThat(sameOwner(claim?.value, active?.storeOwner), 'The master Work claim changed.');
  }

  advanceScopeRevision(flow, attaching) {
    const { issueId, revision } = flow;
    if (attaching) invalidateBlocks(flow, new Set([requestBlock(flow).id]));
    if (!this.service.projectStores) return this.flows.store.save(flow, revision);
    this.flows.store.stage(flow, revision);
    return this.flows.store.flush(issueId, { drain: false });
  }

  checkScopeChange({ master, flow, target, active, operation }, owned = false) {
    requireThat(this.openScope(master, flow), 'Choose an open master before changing its scope.');
    if (operation !== 'folder-detach-blocked') {
      requireThat(owned || this.canDetach(master), 'Wait for the master to be idle before attaching a sub-issue.');
      return this.requireCompatibleChild(master, flow, target.id, operation);
    }
    requireThat(
      owned || this.canDetachBlocked(master, flow, target.id),
      'The master must be in Request, idle, or running Work scoped to the remaining children.'
    );
    requireDetachableSource(flow, flowWorkspace(this.service, flow), target.id, active);
  }

  investigative(master, flow) {
    return master.issue_group?.investigative ?? isInvestigation(master, flow);
  }

  requireCompatibleChild(master, flow, subIssueId, operation, issues = this.flows.issues()) {
    const child = this.flows.selected(subIssueId);
    const childFlow = this.flows.read(child);
    const investigative = this.investigative(master, flow);
    const matches = (issue, issueFlow) => isInvestigation(issue, issueFlow) === investigative;
    requireThat(
      matches(child, childFlow),
      investigative
        ? 'Investigation masters accept only investigative sub-issues.'
        : 'Non-investigation masters accept only non-investigative sub-issues.'
    );
    for (const { id } of groupChildren(master)) {
      const current = this.flows.selected(id);
      requireThat(matches(current, this.flows.read(current)), 'The master already contains incompatible sub-issues.');
    }
    if (operation === 'folder-attach') return this.currentCandidates(flow.folder, [child.id], issues)[0];
    requireThat(this.candidate(child, childFlow, issues), 'The sub-issue must be open, idle, and independent.');
  }

  async saveScopeChange(context, owned = false) {
    const { master, flow, operation } = context;
    const candidate = this.checkScopeChange(context, owned);
    const changes = this.scopeMetadata(context, candidate);
    activeGroupRequest({ ...master, ...changes }, flow);
    const shared = this.service.sharedIssues?.acquire(master, true);
    await updateStoredIssueMetadata(this.service.root, master, changes);
    this.pauseEmpty(master.id, changes.issue_group);
    if (operation === 'folder-attach') this.flows.pause(master.id, 'A sub-issue was attached.');
    const summary = scopeOperations[operation].label;
    if (shared) this.service.sharedIssues.checkpoint(master.id, summary, shared);
    this.service.flowChanges?.notify('flow', master.id);
    return { summary };
  }

  scopeMetadata({ master, flow, target, blocker, actor, operation }, candidate) {
    const scoped = this.withSavedScope(master, flow);
    if (operation === 'folder-detach-blocked') return this.blockedMetadata(scoped, flow, target, blocker, actor);
    if (operation === 'folder-attach') return this.attachedMetadata(scoped, candidate);
    return this.reattachedMetadata(scoped, target);
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
    const restored = {
      ...childRecord({ ...target, previousState: child.state, humanChecks: checks }),
      ...(target.appended && { appended: true }),
    };
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

  attachedMetadata(master, candidate) {
    return {
      updated: new Date().toISOString(),
      issue_group: {
        ...master.issue_group,
        children: [...master.issue_group.children, { ...childRecord(candidate), appended: true }],
      },
      human_checks: [...(master.human_checks ?? []), ...candidate.humanChecks.map(({ check }) => check)],
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
      (entry) =>
        entry.id !== masterId &&
        entry.issue_group?.children?.some(
          (child) => child.id === issue.id && (!child.detachedAt || wasDetachedByMasterRun(child))
        )
    );
    const children = orderedMasterChildren(issue, flow);
    if (!masterId && !formerMasters.length && !children.length && !issue.issue_group) return undefined;
    const proofRows = groupProofRows(flow, undefined, {}, this.service.root);
    const canDetach = this.canDetach(issue);
    return {
      ...(masterId && { master: this.masterView(issue, masterId) }),
      formerMasters: formerMasters.map(issueLink),
      ...this.groupSettings(issue, flow, canDetach),
      children: children.map((child) =>
        this.childView(child, issues, proofRows.get(child.id), canDetach, this.canDetachBlocked(issue, flow, child.id))
      ),
    };
  }

  groupSettings(issue, flow, canDetach) {
    const { reasoning = [], children = [] } = issue.issue_group ?? {};
    const canEdit = canDetach && Boolean(issue.issue_group);
    return {
      reasoning,
      detachedChildren: children.filter(({ detachedAt }) => detachedAt).map(issueLink),
      canReattach: canEdit,
      canAttach: canEdit && this.openScope(issue, flow),
      investigative: this.investigative(issue, flow),
      sequential: sequentialMaster(issue),
      canReorder: this.canReorder(issue, flow),
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
