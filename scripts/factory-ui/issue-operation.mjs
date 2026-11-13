import { flowOwnsIssue } from './flow-ownership.mjs';
import { requireThat } from './common.mjs';

const leased = new WeakMap();

export async function factoryBoundary(service, issueId) {
  requireThat(
    !flowOwnsIssue(service, issueId),
    'A flow block owns this issue. Stop it before starting a classic operation.'
  );
  if (leased.get(service)?.has(issueId)) return;
  await service.issueChats?.beforeFactory?.(issueId);
}

export async function factoryOperation(service, issueId, operation, perform) {
  requireThat(
    !flowOwnsIssue(service, issueId),
    'A flow block owns this issue. Stop it before starting a classic operation.'
  );
  const run = async () => {
    const issues = leased.get(service) || new Set();
    leased.set(service, issues);
    issues.add(issueId);
    try {
      return await perform();
    } finally {
      issues.delete(issueId);
    }
  };
  if (!service.issueChats?.runFactoryOperation) return run();
  if (canReconcile(service.issueChats, operation))
    return service.issueChats.reconcileFactoryOperation(issueId, operation, run);
  return service.issueChats.runFactoryOperation(issueId, operation, run);
}

function canReconcile(chats, operation) {
  return operation.kind === 'merge' && chats.reconcileFactoryOperation;
}
