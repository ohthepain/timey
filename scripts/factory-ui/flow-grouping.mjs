import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digest, requireThat, writeJson } from './common.mjs';
import { closedIssueState } from './data.mjs';
import { requestData } from './flow-block-data.mjs';
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

function childRecord({ id, title, requestedProof, humanChecks }) {
  const links = humanChecks.map(({ originalId, check }) => ({ originalId, masterId: check.id }));
  return { id, title, requestedProof, ...(links.length && { humanChecks: links }) };
}

function detachedGroupMetadata(master, target) {
  const detachedAt = new Date().toISOString();
  const children = master.issue_group.children.map((child) =>
    child.id === target.id ? { ...child, detachedAt } : child
  );
  const checks = new Set(target.humanChecks?.map(({ masterId }) => masterId));
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

function hasQueuedChat(chatQueue) {
  return chatQueue?.operation || chatQueue?.activeTurn || chatQueue?.entries?.length;
}

export class FlowGrouping {
  constructor(flows) {
    this.flows = flows;
    this.service = flows.service;
    this.previews = join(flows.store.directory, 'group-previews');
  }

  masterId(id, issues = this.flows.issues()) {
    return groupMaster(issues, id, closedIssueState(this.service.root))?.id ?? null;
  }

  requireIndependent(id) {
    const master = groupMaster(this.flows.issues(), id, closedIssueState(this.service.root));
    requireThat(!master, `This issue is a sub-issue of ${master?.title}. Work on the master instead.`);
  }

  candidate(issue, flow, issues) {
    const lifecycle = this.service.lifecycleRuns?.[issue.id];
    const chatQueue = this.service.issueChats?.scheduler?.view(issue.id);
    return (
      this.flows.groupEligible(issue, flow) &&
      issue.state !== 'needs-approval' &&
      !issue.issue_group &&
      !this.masterId(issue.id, issues) &&
      !this.flows.overnight?.owns(issue.id) &&
      !lifecycle?.work &&
      !lifecycle?.chatCheckout &&
      !hasQueuedChat(chatQueue) &&
      !flow.destination?.pr
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
          ['reserved', 'setup', 'running', 'blocked', 'completed'].includes(action.status)
        )
      : [];
    return ids.map((id) => {
      const issue = issues.find((entry) => entry.id === id);
      requireThat(issue, 'A selected issue no longer exists. Review the group again.');
      const flow = this.flows.read(issue);
      requireThat(
        flow.folder === folder &&
          this.candidate(issue, flow, issues) &&
          !scheduled.some((action) => action.issues.includes(id)),
        `${issue.title} is no longer an unstarted issue in this folder. Review the group again.`
      );
      const request = requestData(flow);
      return {
        ...issueLink(issue),
        wording: request.wording,
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
    if (input.action === 'folder-detach') return this.detach(input);
    if (input.action === 'folder-group-create') return this.create(input);
    requireThat(input.action === 'folder-group-preview', 'Choose a grouping action.');
    return this.preview(input, reasoning);
  }

  preview({ folder, issueIds }, reasoning) {
    const stores = registeredProjectStores(this.service.root);
    return afterReportWrite(stores?.assertSameStore(issueIds), () => this.previewCurrent(folder, issueIds, reasoning));
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

  create({ previewId, wording, requestId }) {
    requireThat(
      typeof previewId === 'string' && /^[a-f0-9-]{36}$/.test(previewId),
      'Review a current combined request first.'
    );
    const path = join(this.previews, `${previewId}.json`);
    const preview = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    requireThat(preview && preview.expires > Date.now(), 'Review a current combined request first.');
    const stores = registeredProjectStores(this.service.root);
    const ids = preview.grouping.children.map((child) => child.id);
    return afterReportWrite(stores?.assertSameStore(ids), (issueStore) =>
      this.flows.capture(
        {
          requestId,
          description: wording,
          folder: preview.grouping.folder,
          type: preview.type,
          ...(issueStore && { issueStore }),
        },
        preview.grouping
      )
    );
  }

  async detach({ issueId, subIssueId, revision }) {
    const master = this.flows.selected(issueId);
    const flow = this.flows.read(master);
    requireThat(
      !master.closed && !issueHasActiveWork(this.service, issueId) && !this.flows.overnight?.owns(issueId),
      'Wait for the master to be idle before detaching a sub-issue.'
    );
    requireThat(revision === flow.revision, 'The master changed. Review its sub-issues again.');
    const target = groupChildren(master).find(({ id }) => id === subIssueId);
    requireThat(target, 'Choose an attached sub-issue.');
    await this.flows.pause(issueId, 'A sub-issue was detached.');
    const shared = this.service.sharedIssues?.acquire(master, true);
    await this.flows.store.save(flow, revision);
    await updateStoredIssueMetadata(this.service.root, master, detachedGroupMetadata(master, target));
    if (shared) this.service.sharedIssues.checkpoint(issueId, 'Sub-issue detached', shared);
    return this.flows.view(issueId);
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
    const canDetach =
      !issue.closed && !issueHasActiveWork(this.service, issue.id) && !this.flows.overnight?.owns(issue.id);
    return {
      ...(masterId && { master: issueLink(this.flows.issues(masterId)[0] ?? { id: masterId, title: masterId }) }),
      formerMasters: formerMasters.map(issueLink),
      reasoning: issue.issue_group?.reasoning ?? [],
      children: children.map((child) => {
        const current = issues.find(({ id }) => id === child.id);
        const proof = proofRows.get(child.id);
        return {
          ...child,
          ...issueLink(current ?? child),
          canDetach,
          ...(proof && { proof: { status: proof.status, observation: proof.observation } }),
          ...(proof?.status !== 'passed' && {
            nextAction:
              proof?.nextAction || 'Continue on the master to check this request, or detach it to work separately.',
          }),
        };
      }),
    };
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
