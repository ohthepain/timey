import { existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { flowGit, flowWorkspace } from './flow-observer.mjs';
import { requireThat } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export async function moveInvestigationBranch(service, flows, issue, flow, point) {
  const workspace = flowWorkspace(service, flow);
  if (!workspace) {
    requireThat(
      !issue.closed && !flows.active.has(issue.id),
      'Wait for an idle, open investigation before selecting its branch.'
    );
    requireThat(
      !flow.blocks.some((block) => block.kind !== 'request' && block.attempts.length),
      'Restore the investigation checkout before changing its branch.'
    );
    flow.startingPoint = point;
    return flows.store.save(flow, flow.revision);
  }
  requireThat(
    flow.projectInvestigation?.automaticFollowups === true,
    'Only a project investigation checkout can move through this control.'
  );
  requireThat(
    !service.lifecycleRuns?.[issue.id]?.work && !flow.destination?.pr && !workspace.pr,
    'This issue has editable or published work. Change its branch in the issue workspace.'
  );
  requireThat(
    workspace.checkout && existsSync(workspace.checkout),
    'Restore the saved investigation checkout before changing branches.'
  );
  const path = realpathSync(workspace.checkout);
  const managed = realpathSync(join(service.root, '.issues'));
  const local = relative(managed, path);
  requireThat(
    local && local !== '..' && !local.startsWith('..' + sep),
    'The investigation checkout must remain inside its managed project directory.'
  );
  const [head, branch, common, dirty, untracked] = await Promise.all([
    flowGit(path, 'rev-parse', 'HEAD'),
    flowGit(path, 'branch', '--show-current'),
    flowGit(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    flowGit(path, 'status', '--porcelain', '--untracked-files=no'),
    flowGit(path, 'ls-files', '--others', '--exclude-standard'),
  ]);
  const expectedCommon = await flowGit(service.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  requireThat(
    realpathSync(common) === realpathSync(expectedCommon) && branch === workspace.branch,
    'The saved investigation checkout changed identity. Reconcile it in the issue workspace.'
  );
  requireThat(
    head === workspace.base && !dirty && untracked.split('\n').every((name) => !name || name.startsWith('.issues/')),
    'The investigation checkout has source edits or commits. Preserve them and change its branch in the issue workspace.'
  );
  requireThat(
    !flows.active.has(issue.id) && flows.read(flows.selected(issue.id)).revision === flow.revision,
    'The investigation changed while its branch was inspected. Refresh and try again.'
  );
  const owned = {
    controller: new AbortController(),
    blockId: 'move-starting-point',
    attemptId: 'project-investigation-branch',
    movingStartingPoint: true,
  };
  flows.active.set(issue.id, owned);
  try {
    await flowGit(path, 'reset', '--keep', point.commit);
    flow.startingPoint = point;
    flow.workspace = { ...workspace, base: point.commit };
    flows.store.save(flow, flow.revision);
    const record = service.lifecycleRuns?.[issue.id];
    if (record?.chatCheckout)
      saveLifecycle(service, record, { chatCheckout: { ...record.chatCheckout, base: point.commit } });
  } finally {
    if (flows.active.get(issue.id) === owned) flows.active.delete(issue.id);
  }
  return { moved: true };
}
