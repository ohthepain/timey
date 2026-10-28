import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git, requireThat, writeJson } from './common.mjs';
import { selectedWorkerTurn } from './worker-turn.mjs';
import { loadSavedChat } from './issue-work-chat.mjs';

function mergeHead(checkout) {
  const path = git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

// Only resume the exact merge started by this run's explicit branch-update click.
export function pendingBranchMerge(service, run, input) {
  const path = run.verification.updateReceipt;
  if (!path || !existsSync(path)) return false;
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const matches =
    receipt.actor === 'human' &&
    receipt.operation === 'update-branch-and-retry' &&
    receipt.actionId === run.actionId &&
    receipt.originalBase === run.base &&
    receipt.from === git(run.checkout, 'rev-parse', 'HEAD') &&
    receipt.selectedBranch === input.branch &&
    mergeHead(run.checkout) === receipt.selectedRevision;
  return matches ? receipt : false;
}

export async function updateVerificationBranch(service, run, action, branch) {
  requireThat(
    git(run.checkout, 'rev-parse', branch.ref) === branch.revision,
    'The selected branch moved. Refresh and select it again.'
  );
  const pending = pendingBranchMerge(service, run, { branch: branch.ref, branchRevision: branch.revision });
  if (pending) {
    await resolveMerge(service, run, { ...branch, revision: pending.selectedRevision });
  }
  if (!pending || pending.selectedRevision !== branch.revision) {
    const receipt = join(service.store.directory, run.id + '-branch-update-' + Date.now() + '.json');
    writeJson(receipt, {
      actor: 'human',
      operation: 'update-branch-and-retry',
      actionId: action.id,
      from: git(run.checkout, 'rev-parse', 'HEAD'),
      selectedBranch: branch.ref,
      selectedRevision: branch.revision,
      originalBase: run.base,
      at: new Date().toISOString(),
      grantsAcceptance: false,
    });
    service.store.update(run, { verification: { ...run.verification, updateReceipt: receipt } });
    try {
      git(run.checkout, 'merge', '--no-edit', branch.revision);
    } catch (error) {
      if (mergeHead(run.checkout) !== branch.revision) throw error;
    }
  }
  if (mergeHead(run.checkout)) await resolveMerge(service, run, branch);
  requireThat(
    !git(run.checkout, 'status', '--porcelain'),
    'The branch update is unfinished; preserve and resolve its remaining changes before checking.'
  );
}

function conflicts(checkout) {
  return git(checkout, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
}
function unchangedFiles(checkout, allowed) {
  const paths = git(checkout, 'ls-files', '-z').split('\0').filter(Boolean);
  return paths
    .filter((p) => !allowed.has(p))
    .map((p) => [p, existsSync(join(checkout, p)) ? digest(readFileSync(join(checkout, p))) : null]);
}
async function resolveMerge(service, run, branch) {
  const before = git(run.checkout, 'rev-parse', 'HEAD');
  const workingBranch = git(run.checkout, 'symbolic-ref', 'HEAD');
  const paths = conflicts(run.checkout);
  if (paths.length) {
    requireThat(run.threadId, 'Reconnect the issue’s existing implementation chat to resolve this merge.');
    service.store.update(run, {
      summary: 'Codex is resolving merge conflicts from ' + branch.name + '.',
      verification: { ...run.verification, conflicts: paths },
    });
    const unloaded = await loadSavedChat(service.codex, run.threadId, run.checkout, 'workspace-write');
    if (!unloaded) await service.codex.resume(run.threadId, run.checkout, 'workspace-write');
    if (!run.resultTurnId) {
      const turn = await selectedWorkerTurn(service.codex, run.threadId);
      requireThat(
        turn.status === 'completed',
        'Retain the original completed implementation turn before resolving conflicts.'
      );
      service.store.update(run, { resultTurnId: turn.id, resultRevision: before });
    }
    const allowed = new Set(paths);
    if (paths.some((p) => p === 'package.json' || p.endsWith('/package.json'))) allowed.add('pnpm-lock.yaml');
    const unchanged = unchangedFiles(run.checkout, allowed);
    const untracked = git(run.checkout, 'ls-files', '--others', '--exclude-standard', '-z');
    const result = JSON.parse(
      await service.codex.turn(
        run.threadId,
        run.checkout,
        `Resolve only the existing merge conflicts for action ${run.actionId} in ${run.checkout}. This explicit Update from branch and retry action authorizes a local merge from ${branch.ref} at ${branch.revision} into HEAD ${before}. Preserve both the approved issue implementation and incoming branch behavior. Conflicted files: ${JSON.stringify(paths)}. You may edit only these files${allowed.has('pnpm-lock.yaml') ? ' and regenerate pnpm-lock.yaml if needed for package compatibility' : ''}. Resolve and git add those paths; do not commit, abort/reset the merge, switch branches, push, publish, merge into the project branch or accept/close an issue. Keep the original base ${run.base}. If needed, install matching dependencies with pnpm install --frozen-lockfile. The server will commit through required hooks and independently run full verification and the saved-base step audit. Do not weaken checks. Make one bounded attempt; if intended behavior needs a human decision, report blocked with the exact decision. Return completed only when all conflicts are resolved and staged.`,
        {
          type: 'object',
          additionalProperties: false,
          properties: { outcome: { type: 'string', enum: ['completed', 'blocked'] }, summary: { type: 'string' } },
          required: ['outcome', 'summary'],
        }
      )
    );
    const receipt = join(service.store.directory, run.id + '-conflict-resolution-' + Date.now() + '.json');
    writeJson(receipt, {
      threadId: run.threadId,
      turnId: run.completedTurnId || null,
      from: before,
      selectedRevision: branch.revision,
      paths,
      result,
    });
    service.store.update(run, { verification: { ...run.verification, conflictResolution: receipt } });
    requireThat(
      git(run.checkout, 'rev-parse', 'HEAD') === before &&
        mergeHead(run.checkout) === branch.revision &&
        git(run.checkout, 'symbolic-ref', 'HEAD') === workingBranch,
      'Conflict resolution changed the merge identity. Reconcile the checkout before retrying.'
    );
    requireThat(
      JSON.stringify(unchangedFiles(run.checkout, allowed)) === JSON.stringify(unchanged) &&
        git(run.checkout, 'ls-files', '--others', '--exclude-standard', '-z') === untracked,
      'Conflict resolution changed files outside the permitted paths. Review the retained checkout; no verification pass was recorded.'
    );
    requireThat(result.outcome === 'completed', 'Conflict resolution needs attention: ' + result.summary);
    requireThat(
      conflicts(run.checkout).length === 0,
      'Codex left unresolved conflicts. Review its saved result before retrying.'
    );
  }
  requireThat(
    !git(run.checkout, 'diff', '--name-only'),
    'Stage all resolved merge changes before completing the branch update.'
  );
  // Git runs the configured staged audit hook; failed hooks leave this merge resumable.
  git(run.checkout, 'commit', '--no-edit');
  service.store.update(run, {
    summary: 'Branch update complete. Checking the combined changes.',
    verification: { ...run.verification, conflicts: [] },
  });
}
