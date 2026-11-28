import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { readQueue } from './data.mjs';

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
function assemblyBlockReason(summary) {
  if (/issue-delivery-config\.json|Pull request settings are missing/.test(summary || ''))
    return 'Pull request settings have not been saved. Set the target branch in Project settings.';
  if (/Required check failed|A required check|verification|Evidence does not match/i.test(summary || ''))
    return 'A check of the existing issue branch failed. The implementation and original merge are kept. Fix the reported problem separately, then run the checks in Flow.';
  return 'The existing operation could not finish. Its work is kept. Resolve the problem shown below, then continue in Flow.';
}
