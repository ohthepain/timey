import { runOwnedOperation } from './owned-operation.mjs';
import { observeDisconnectedFlow } from '../flow-reconciliation.mjs';
import { pendingIssueMerge } from '../flow-merge-state.mjs';
import { abortPendingMerge } from '../flow-update-branch.mjs';
import { moveFlowStartingPoint } from '../flow-executor.mjs';
import { invalidateBlocks } from '../flow-block-data.mjs';
import { git, requireThat } from '../common.mjs';

function reconcileDisconnected(current, disconnected) {
  const unresolved = (attempt) =>
    !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status);
  for (const saved of disconnected) {
    const block = current.blocks.find((entry) => entry.id === saved.id);
    for (const previous of block.attempts.filter(unresolved)) {
      previous.reconciledAt = new Date().toISOString();
      previous.reconciliation = 'The original provider was observed idle before this explicit branch update.';
      if (['running', 'stopping'].includes(previous.status)) previous.status = 'uncertain';
    }
  }
}

export async function updateOwnedWorktree(flows, issue, flow, input) {
  const disconnected = await observeDisconnectedFlow(flows.service, flow, flows.deliveryOptions.createConnection);
  return runOwnedOperation(flows, {
    issue,
    flow,
    label: 'Update issue branch manually',
    operation: 'manual-update',
    run: async (context) => {
      context.change((_, current) => reconcileDisconnected(current, disconnected));
      flows.pauseAutoplay(issue.id, 'Updating the branch manually.');
      return flows.executor.run({
        issue,
        ...context,
        input,
        onWorkspace: (workspace) =>
          context.change((_, current) => {
            current.workspace = workspace;
          }),
      });
    },
  });
}

export async function abortOwnedMerge(flows, { issue, flow, workspace, merge }) {
  return runOwnedOperation(flows, {
    issue,
    flow,
    label: 'Abort local merge',
    operation: 'abort-merge',
    run: async ({ signal }) => {
      signal.throwIfAborted();
      requireThat(
        JSON.stringify(pendingIssueMerge(workspace.checkout)) === JSON.stringify(merge),
        'The merge changed before its ownership was confirmed.'
      );
      await abortPendingMerge(workspace, (command, args) => git(workspace.checkout, ...args));
      flows.pauseAutoplay(issue.id, 'The local merge was aborted.');
      return { summary: 'The local merge was aborted.' };
    },
  });
}

export async function moveOwnedStartingPoint(flows, { issue, flow, workspace, point }) {
  return runOwnedOperation(flows, {
    issue,
    flow,
    label: 'Move issue starting branch',
    operation: 'move-starting-point',
    movingStartingPoint: true,
    run: async ({ flow: ownedFlow, block, attempt, signal, change }) => {
      const moved = await moveFlowStartingPoint(flows.service, { issue, flow: ownedFlow, attempt, signal }, point);
      change((_, current) => {
        current.workspace = { ...workspace, ...moved };
        current.startingPoint = point;
        invalidateBlocks(
          current,
          new Set(
            current.blocks.filter((item) => item.kind !== 'request' && item.id !== block.id).map((item) => item.id)
          )
        );
      });
      flows.pauseAutoplay(issue.id, 'The issue starting branch was moved.');
      return { summary: 'The issue starting branch was moved.' };
    },
  });
}
