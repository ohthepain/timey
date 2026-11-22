import { randomUUID } from 'node:crypto';
import { requireStore, readStoreConfig } from './stores/config.mjs';
import { readQueue } from './data.mjs';
import { requireThat } from './common.mjs';
import { setPriority } from './issue-priority.mjs';
import { assignIssueFolder } from './issue-folders.mjs';
import { createIssueFlows } from './flow-service.mjs';

const editableFields = new Set(['folderId', 'priorityId', 'targetBranch', 'reusable', 'runRetro', 'issueStore']);

export async function editProjectIssues(service, input, projectHome) {
  service.ownServer();
  const issueIds = [...new Set(input.issueIds || [])];
  const changes = input.changes || {};
  requireThat(issueIds.length > 1, 'Select at least two issues.');
  requireThat(
    Object.keys(changes).length > 0 && Object.keys(changes).every((field) => editableFields.has(field)),
    'Choose at least one supported issue field to change.'
  );

  const flows = service.flows || (service.flows = createIssueFlows(service));
  const initialQueue = readQueue(service.root);
  requireThat(
    issueIds.every((id) => initialQueue.issues.some((issue) => issue.id === id)),
    'Refresh the issue list.'
  );
  if (changes.folderId !== undefined)
    requireThat(
      initialQueue.issueFolders.some((folder) => folder.id === changes.folderId),
      'Choose a current issue folder.'
    );
  if (changes.priorityId !== undefined)
    requireThat(
      initialQueue.priorities.some((priority) => priority.id === changes.priorityId),
      'Choose a current priority.'
    );
  if (changes.targetBranch !== undefined)
    requireThat(
      changes.targetBranch === null || typeof changes.targetBranch === 'string',
      'Choose a valid target branch.'
    );
  for (const field of ['reusable', 'runRetro'])
    if (changes[field] !== undefined)
      requireThat(typeof changes[field] === 'boolean', `Choose whether ${field} is on or off.`);

  if (changes.issueStore !== undefined) {
    requireThat(service.projectStores, 'Project storage is unavailable.');
    requireStore(readStoreConfig(service.root), changes.issueStore, 'issue');
  }
  const onlyStore = Object.keys(changes).every((key) => key === 'issueStore');
  const views = await editableIssueViews(flows, issueIds, onlyStore);
  if (changes.targetBranch !== undefined)
    requireThat(
      [...views.values()].every((view) => !view.destination.locked),
      'Target branch is locked for at least one selected issue. No changes were made.'
    );
  if (changes.reusable !== undefined)
    requireThat(
      [...views.values()].every(
        (view) => view.issues.find((issue) => issue.id === view.issue.id)?.type === 'investigation'
      ),
      'Reusable applies only when every selected issue is an investigation. No changes were made.'
    );

  const results = [];
  const operationId = input.operationId || 'bulk-' + randomUUID();
  let moved = false;
  if (changes.issueStore !== undefined) {
    try {
      await moveSelectedStores(service, issueIds, changes.issueStore, operationId);
      moved = true;
    } catch (error) {
      return {
        results: issueIds.map((issueId) => ({
          issueId,
          applied: [],
          errors: ['Issue store: ' + error.message],
          success: false,
        })),
      };
    }
  }
  for (const issueId of issueIds)
    results.push(await applyIssueChanges({ service, flows, projectHome, issueId, changes, moved }));
  return { results };
}

async function applyIssueChanges(context) {
  const result = { issueId: context.issueId, applied: context.moved ? ['issue store'] : [], errors: [] };
  for (const [field, change] of Object.entries(changeActions)) {
    if (context.changes[field] === undefined) continue;
    try {
      await change.apply(context, context.changes[field]);
      result.applied.push(change.label.toLowerCase());
    } catch (error) {
      result.errors.push(change.label + ': ' + error.message);
    }
  }
  return { ...result, success: result.errors.length === 0 };
}

const changeActions = {
  folderId: {
    label: 'Folder',
    async apply({ service, issueId }, folderId) {
      const queue = readQueue(service.root);
      await assignIssueFolder(service.root, queue.issues, { issueId, folderId, basis: queue.issueFolderBasis });
    },
  },
  priorityId: {
    label: 'Priority',
    async apply({ service, issueId }, priorityId) {
      const issue = readQueue(service.root).issues.find((entry) => entry.id === issueId);
      requireThat(issue?.priorityInfo.index >= 0, 'This issue has a priority that is not in the current list.');
      await setPriority(service, { issueId, priorityId, basis: issue.priorityInfo.basis });
    },
  },
  targetBranch: {
    label: 'Target branch',
    async apply({ flows, issueId }, branch) {
      const current = await flows.view(issueId);
      await flows.action({ issueId, action: 'destination', revision: current.flow.revision, branch });
    },
  },
  reusable: {
    label: 'Reusable',
    async apply({ flows, projectHome, issueId }, reusable) {
      const current = await flows.view(issueId);
      requireThat(projectHome, 'Project settings are unavailable.');
      await projectHome.action({ issueId, action: 'investigation-save', revision: current.flow.revision, reusable });
    },
  },
  runRetro: {
    label: 'Retro',
    async apply({ flows, issueId }, enabled) {
      const current = await flows.view(issueId);
      await flows.action({ issueId, action: 'retro-setting', revision: current.flow.revision, enabled });
    },
  },
};

async function moveSelectedStores(service, issueIds, storeId, operationId) {
  const matching = (entry) =>
    entry.value.status === 'pending' &&
    entry.value.kind === 'move-issue' &&
    entry.value.input.storeId === storeId &&
    JSON.stringify([...entry.value.input.ids].sort()) === JSON.stringify([...issueIds].sort());
  const pending = (await service.projectStores.coordination.list('operations/')).find(matching);
  await service.projectStores.moveIssue({ issueIds, storeId, operationId: pending?.value.id || operationId });
  await service.projectStores.refresh();
}

async function editableIssueViews(flows, issueIds, onlyStore = false) {
  const views = new Map();
  for (const issueId of issueIds) {
    if (!onlyStore) await flows.requireEditableIssue(issueId);
    views.set(issueId, await flows.view(issueId));
  }
  return views;
}
