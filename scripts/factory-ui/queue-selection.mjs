// Scheduling is deterministic; optional queue discussion never owns execution.
function implementationRank(issue) {
  return issue.implementationOrder ?? Number.MAX_SAFE_INTEGER;
}

function compareCandidates(a, b) {
  const order = a.implementationOrder - b.implementationOrder;
  if (order) return order;
  return comparePriorityAndAge(a, b);
}

function comparePriorityAndAge(a, b) {
  const priority = a.priority - b.priority;
  if (priority) return priority;
  const age = a.created - b.created;
  if (age) return age;
  return a.id.localeCompare(b.id);
}

export function compactQueue(service, queue) {
  const major = queue.priorities?.findIndex((priority) => priority.id === 'major') ?? 2;
  const closed = queue.lifecycle.find((stage) => stage.role === 'closed')?.state;
  return queue.issues
    .filter((issue) => issue.state !== closed)
    .map((issue) => {
      const progress = service.lifecycleRuns[issue.id];
      const shared = service.sharedIssues?.view(issue.id);
      return {
        id: issue.id,
        title: issue.title?.slice(0, 160),
        state: issue.state,
        priority: issue.priorityInfo?.index >= 0 ? issue.priorityInfo.index : Math.max(major, 0),
        implementationOrder: implementationRank(issue),
        stage: queue.lifecycle.findIndex((stage) => stage.state === issue.state),
        created: Date.parse(issue.created) || 0,
        running: service.lifecycleTasks.has(issue.id) || Boolean(shared?.claimed),
        pendingReport: Boolean(
          shared &&
          (!shared.published || !issue.issueNumber || (shared.checkpoint && shared.checkpoint.status !== 'published'))
        ),
        needsInput: Boolean(progress?.input),
        status: progress?.status || (shared ? issue.shared_progress : null) || 'not-started',
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
      !item.pendingReport &&
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
        'ready-to-merge',
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
  eligible.sort(compareCandidates);
  const selected = eligible[0];
  const choice = {
    next_issue_id: selected?.id || null,
    reason: selected
      ? `Selected ${selected.title || selected.id}: earliest in the saved implementation order.`
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
