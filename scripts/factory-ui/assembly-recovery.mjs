import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { requireThat } from './common.mjs';
import { readQueue } from './data.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';

export function assemblyRecoveryView(service, issue, record) {
  if (record?.status !== 'blocked') return null;
  const run = service.store.runs.find((r) => r.id === record.childRunId);
  if (run?.kind !== 'assembly' || run.status !== 'blocked') return null;
  const action = readQueue(service.root).actions.find((a) => a.id === run.actionId);
  if (!action || !action.issues.includes(issue.id) || action.status !== 'completed') return null;
  const delivery = service.deliveries.inspect(issue.id);
  const log = /See (.+)/.exec(run.summary || '')?.[1];
  return {
    runId: run.id,
    reason: assemblyBlockReason(run.summary),
    detail: run.summary,
    checkout: delivery?.checkout || null,
    log: log && existsSync(log) ? log : null,
    output: checkOutput(service.root, log),
    updated: record.updated,
  };
}
function checkOutput(root, log) {
  if (!log || !existsSync(log)) return '';
  const path = realpathSync(log),
    folder = realpathSync(root) + sep + '.issues' + sep;
  if (!path.startsWith(folder)) return '';
  return readFileSync(path, 'utf8').slice(-6000);
}
export function assemblyBlockReason(summary) {
  if (/issue-delivery-config\.json|Pull request settings are missing/.test(summary || ''))
    return 'Pull request settings have not been saved. Retry will apply your saved branch choice, or ask you to choose one.';
  if (/Required check failed|A required check|verification|Evidence does not match/i.test(summary || ''))
    return 'A check of the existing issue branch failed. The implementation and original merge are kept. Fix the reported problem separately, then retry the checks here.';
  return 'The existing operation could not finish. Its work is kept. Resolve the problem shown below, then retry here; implementation will not restart.';
}
export function retryAssembly(service, input, after) {
  service.ownServer();
  const issue = readQueue(service.root).issues.find((i) => i.id === input.issueId);
  const record = service.lifecycleRuns[input.issueId];
  requireThat(issue && record, 'This issue has no stopped operation to retry.');
  const view = assemblyRecoveryView(service, issue, record);
  requireThat(
    view?.runId === input.runId && record.updated === input.updated,
    'The operation changed. Refresh before retrying.'
  );
  requireThat(!service.lifecycleTasks.has(issue.id), 'This issue is already continuing.');
  requireThat(
    !service.store.runs.some(
      (r) =>
        service.store.connected.has(r.id) &&
        (r.issueId === issue.id || r.actionId === service.store.runs.find((r) => r.id === view.runId).actionId)
    ),
    'Work on this issue is still running. Wait for it to finish.'
  );
  service.serverControl?.allow('/api/assembly-retry');
  saveLifecycle(service, record, { attempts: [], recoveryContexts: [], replan: false });
  after(issue.id);
  return { issueId: issue.id };
}
