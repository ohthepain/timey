// Queue coordination chooses an issue, never an implementation assignment.
export async function selectNextIssue(service, run, queue) {
  const items = queue.issues.map((issue) => {
    const progress = service.lifecycleRuns[issue.id];
    return { id: issue.id, title: issue.title?.slice(0, 160), state: issue.state,
      running: service.lifecycleTasks.has(issue.id), needsInput: Boolean(progress?.input),
      status: progress?.status || 'not-started', summary: progress?.summary?.slice(0, 240) };
  });
  const ids = items.filter((i) => !i.running && !i.needsInput &&
    queue.lifecycle.find((s) => s.state === i.state)?.role !== 'closed').map((i) => i.id);
  const choice = JSON.parse(await service.coordinator.turn(run,
    'Choose which eligible issue should advance next from this compact queue. Return only its ID and a short reason. Do not inspect code, chat histories, ledgers, plans or test logs, plan assignments, or review approvals. Each issue chat owns its own work. Choosing grants no execution permission. Queue: ' + JSON.stringify(items),
    { type: 'object', properties: { next_issue_id: { type: ['string', 'null'], enum: [...ids, null] }, reason: { type: 'string' } }, required: ['next_issue_id', 'reason'], additionalProperties: false }, 'Choosing next issue'));
  if (choice.next_issue_id !== null && !ids.includes(choice.next_issue_id)) throw Error('Coordinator selected an ineligible issue.');
  return { summary: choice.reason, next_issue_id: choice.next_issue_id, recommendations: [], routes: [],
    continuation: null, record_update: null, human_question: null, next_action: choice.next_issue_id ? 'work' : 'blocked',
    next_step: choice.next_issue_id ? `Continue issue ${choice.next_issue_id} in its owning chat.` : 'No issue is currently eligible.' };
}
