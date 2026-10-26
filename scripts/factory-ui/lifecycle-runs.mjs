const actionRoles = {
  investigate: 'ready-for-repro',
  prototype: 'ready-to-prototype',
  implement: 'ready-to-fix',
  integrate: 'ready-to-fix',
  verify: 'ready-to-verify',
  review: 'ready-to-close',
};

function linkedStage(action, stage, kind) {
  if (!action || !stage) return false;
  if (kind === 'integration') return action.status === 'completed';
  return actionRoles[action.kind] === stage.role;
}

export function sameStage(queue, issue, run) {
  if (run.issueState) return run.issueState === issue.state;
  const action = queue.actions.find((a) => a.id === run.actionId);
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  return linkedStage(action, stage, run.kind);
}
