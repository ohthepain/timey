import { readQueue } from './data.mjs';
import { requireThat } from './common.mjs';
import { setPriority } from './issue-priority.mjs';
import { assignIssueFolder } from './issue-folders.mjs';
import { createIssueFlows } from './flow-service.mjs';

const editableFields = new Set(['folderId', 'priorityId', 'targetBranch', 'reusable', 'runRetro']);

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

  const views = new Map();
  for (const issueId of issueIds) views.set(issueId, await flows.view(issueId));
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
  for (const issueId of issueIds) {
    const result = { issueId, applied: [], errors: [] };
    if (changes.folderId !== undefined) {
      try {
        const queue = readQueue(service.root);
        assignIssueFolder(service.root, queue.issues, {
          issueId,
          folderId: changes.folderId,
          basis: queue.issueFolderBasis,
        });
        result.applied.push('folder');
      } catch (error) {
        result.errors.push(`Folder: ${error.message}`);
      }
    }
    if (changes.priorityId !== undefined) {
      try {
        const queue = readQueue(service.root);
        const issue = queue.issues.find((entry) => entry.id === issueId);
        requireThat(issue?.priorityInfo.index >= 0, 'This issue has a priority that is not in the current list.');
        setPriority(service, {
          issueId,
          priorityId: changes.priorityId,
          basis: issue.priorityInfo.basis,
        });
        result.applied.push('priority');
      } catch (error) {
        result.errors.push(`Priority: ${error.message}`);
      }
    }
    if (changes.targetBranch !== undefined) {
      try {
        const current = await flows.view(issueId);
        await flows.action({
          issueId,
          action: 'destination',
          revision: current.flow.revision,
          branch: changes.targetBranch,
        });
        result.applied.push('target branch');
      } catch (error) {
        result.errors.push(`Target branch: ${error.message}`);
      }
    }
    if (changes.reusable !== undefined) {
      try {
        const current = await flows.view(issueId);
        requireThat(projectHome, 'Project settings are unavailable.');
        await projectHome.action({
          action: 'investigation-save',
          issueId,
          revision: current.flow.revision,
          reusable: changes.reusable,
        });
        result.applied.push('reusable');
      } catch (error) {
        result.errors.push(`Reusable: ${error.message}`);
      }
    }
    if (changes.runRetro !== undefined) {
      try {
        const current = await flows.view(issueId);
        await flows.action({
          issueId,
          action: 'retro-setting',
          revision: current.flow.revision,
          enabled: changes.runRetro,
        });
        result.applied.push('retro');
      } catch (error) {
        result.errors.push(`Retro: ${error.message}`);
      }
    }
    results.push({ ...result, success: result.errors.length === 0 });
  }
  return { results };
}
