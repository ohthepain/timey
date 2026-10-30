// Scheduling is deterministic; optional queue discussion never owns execution.
export function compactQueue(service, queue) {
  const major = queue.priorities?.findIndex((priority) => priority.id === 'major') ?? 2;
  return queue.issues.map((issue) => {
    const progress = service.lifecycleRuns[issue.id];
    return {
      id: issue.id,
      title: issue.title?.slice(0, 160),
      state: issue.state,
      priority: issue.priorityInfo?.index >= 0 ? issue.priorityInfo.index : Math.max(major, 0),
      stage: queue.lifecycle.findIndex((stage) => stage.state === issue.state),
      created: Date.parse(issue.created) || 0,
      running: service.lifecycleTasks.has(issue.id),
      needsInput: Boolean(progress?.input),
      status: progress?.status || 'not-started',
      summary: progress?.summary?.slice(0, 240),
    };
  });
}

export async function selectNextIssue(service, run, queue) {
  const items = compactQueue(service, queue);
  const eligible = items.filter((item) => {
    const role = queue.lifecycle[item.stage]?.role;
    return (
      item.stage >= 0 &&
      !item.running &&
      !item.needsInput &&
      ![
        'running',
        'preparing',
        'checking',
        'blocked',
        'failed',
        'paused',
        'waiting',
        'answering',
        'completed',
        'finished',
        'handed-off',
        'merged',
      ].includes(item.status) &&
      !['ready-to-close', 'closed'].includes(role) &&
      !queue.actions?.some(
        (action) =>
          action.issues.includes(item.id) &&
          ['reserved', 'setup', 'running', 'blocked', 'failed'].includes(action.status)
      )
    );
  });
  eligible.sort((a, b) => a.priority - b.priority || a.created - b.created || a.id.localeCompare(b.id));
  const selected = eligible[0];
  const choice = {
    next_issue_id: selected?.id || null,
    reason: selected
      ? `Selected ${selected.title || selected.id}: highest priority, then oldest eligible issue.`
      : 'No issue is currently eligible. Blocked issues need manual attention.',
  };
  return {
    summary: choice.reason,
    next_issue_id: choice.next_issue_id,
    recommendations: [],
    routes: [],
    continuation: null,
    record_update: null,
    human_question: null,
    next_action: choice.next_issue_id ? 'work' : 'blocked',
    next_step: choice.next_issue_id
      ? `Continue issue ${choice.next_issue_id} in its owning chat.`
      : 'No issue is currently eligible.',
  };
}
