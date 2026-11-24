import { sameOwner } from './coordination.mjs';
import { retireRecoveredPending } from '../flow-store.mjs';

export async function reconcileRecoveredProgress(service, stores, issueId) {
  const store = service.flows?.store;
  const pending = store?.pendingFlow(issueId);
  if (!pending?.owner || pending.owner.issueId !== issueId || service.flows.active.has(issueId)) return;
  const recoveries = await stores.coordination.list('operations/ownership-recovery-');
  const recovery = recoveries.find(({ value }) => {
    const input = value.input;
    return (
      value.kind === 'recover-attempt' &&
      value.status === 'confirmed' &&
      input.issueId === issueId &&
      sameOwner(pending.owner, { ...input, token: input.ownerToken })
    );
  });
  if (recovery) retireRecoveredPending(store, pending.owner, recovery);
}
