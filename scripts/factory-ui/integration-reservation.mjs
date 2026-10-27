import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read-only availability check: polling never takes over or completes a reservation.
export function integrationReservation(service, issueId, queue) {
  const path = join(service.root, '.issues/factory-integration.lock/owner.json');
  if (!existsSync(path)) return null;
  let owner;
  try {
    owner = JSON.parse(readFileSync(path));
  } catch {
    return null;
  }
  if (!owner || typeof owner !== 'object') return null;
  const run = service.store.runs.find((r) => r.id === owner.runId && r.kind === 'integration');
  const action = queue.actions.find((a) => a.id === run?.actionId);
  if (!run || !action?.issues.includes(issueId) || !['completed', 'integrated'].includes(action.status)) return null;
  if (service.store.connected.has(run.id) || service.codex.turns?.has(run.threadId)) return null;
  return { owner, run, action };
}
