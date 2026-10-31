import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { appendCompletion } from '../factory-completion.mjs';
import { digest, requireThat } from './common.mjs';

export function changePriority(service, input) {
  service.ownServer();
  const queue = readQueue(service.root);
  const issue = queue.issues.find((entry) => entry.id === input.issueId);
  requireThat(issue, 'This issue no longer exists. Refresh the queue.');
  requireThat(['up', 'down'].includes(input.direction), 'Choose a higher or lower priority.');
  const current = issue.priorityInfo;
  requireThat(current.basis === input.basis, 'The priority or project list changed. Refresh before changing it again.');
  const next = current.index + (input.direction === 'up' ? -1 : 1);
  const choice = queue.priorities[next];
  requireThat(current.index >= 0 && choice, 'This issue cannot move further in that direction.');
  const run = {
    id: randomUUID(),
    kind: 'priority-choice',
    base: queue.head,
    authorization: { kind: 'direct-user', operation: 'change-priority' },
  };
  const summary = `Priority changed from ${current.name} to ${choice.name} by the user.`;
  const result = {
    outcome: 'completed',
    summary,
    notes: 'Only the priority changed. Existing work, checks and lifecycle stage are preserved.',
    remaining: [],
    stage_records: [],
    priority_update: choice.id,
  };
  appendCompletion(
    service.root,
    issue,
    result,
    run,
    [{ path: join(service.root, '.issues', issue.id + '.md'), sha256: digest(issue.content) }],
    null
  );
  return { priority: choice.id };
}
