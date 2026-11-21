export function liveSavedRun(store, action, kind, base, values = {}) {
  const run = store.add(action, kind, base);
  store.update(run, { issueId: action.issueId, status: 'running', ...values });
  store.connected.add(run.id);
  return run;
}

export function disconnectedSavedRun(store, action, kind, base, values = {}) {
  const run = store.add(action, kind, base);
  store.update(run, { issueId: action.issueId, status: 'completed', ...values });
  store.connected.delete(run.id);
  return run;
}
