import { assemblyBlockReason } from './assembly-recovery.mjs';
import { stopLifecycle } from './lifecycle-stop.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';
import { requireThat } from './common.mjs';

export async function waitLifecycleWork(service, record, queue) {
  const active = service.store.runs.findLast(
    (r) => belongsToLifecycle(record, queue, r) && service.store.connected.has(r.id)
  );
  if (active) {
    saveLifecycle(service, record, {
      childRunId: active.id,
      summary: active.summary,
    });
    const run = await waitForChild(service, record, active.id);
    if (run.status !== 'completed') await handleLifecycleFailure(service, record, run);
    return true;
  }
  const interrupted = service.store.runs.findLast(
    (r) => belongsToLifecycle(record, queue, r) && ['running', 'preparing', 'checking'].includes(r.status)
  );
  if (!interrupted) return false;
  return reconnectLifecycleWork(service, record, interrupted);
}
async function reconnectLifecycleWork(service, record, interrupted) {
  service.store.update(interrupted, { status: 'blocked' });
  stopLifecycle(
    service,
    record,
    `Work was interrupted. Review the saved result and retry the operation manually. ${interrupted.summary || ''}`
  );
  return true;
}
function belongsToLifecycle(record, queue, run) {
  return (
    run.issueId === record.issueId ||
    queue.actions.some((a) => a.id === run.actionId && a.issues.includes(record.issueId))
  );
}
export async function handleLifecycleFailure(service, record, run) {
  const summary = run.kind === 'assembly' ? assemblyBlockReason(run.summary) : run.summary;
  stopLifecycle(service, record, summary || 'The operation failed. Review its saved output and retry manually.');
  return false;
}

export async function waitForChild(service, record, id) {
  while (service.store.connected.has(id)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const run = service.store.runs.find((r) => r.id === id);
  requireThat(run, 'The saved activity record is missing. No replacement work was started.');
  lifecycleEvent(service, record, record.status === 'running' ? run.summary : record.summary, {
    runId: run.id,
    result: run.status,
  });
  return run;
}
