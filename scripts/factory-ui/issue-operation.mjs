const leased = new WeakMap();

export async function factoryBoundary(service, issueId) {
  if (leased.get(service)?.has(issueId)) return;
  await service.issueChats?.beforeFactory?.(issueId);
}

export async function factoryOperation(service, issueId, operation, perform) {
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
