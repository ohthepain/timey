import { approvedPlan } from '../issue-delivery-policy.mjs';
import { planAuthorization } from '../factory-authorization.mjs';
import { launchProblem, readQueue } from './data.mjs';
import { requireThat, digest } from './common.mjs';
import { lifecycleEvent, saveLifecycle } from './lifecycle-store.mjs';

export function recommendationRefresh(queue, issue, action) {
  if (action.status !== 'recommended' || action.threadId || action.clientThreadId) return null;
  if (action.issues.length !== 1 || action.issues[0] !== issue.id) return null;
  if (launchProblem(queue, action)?.code !== 'stale-recommendation') return null;
  try {
    approvedPlan(queue.root, issue.id);
  } catch {
    return null;
  }
  return {
    kind: 'refresh-recommendation',
    actionId: action.id,
    title: 'Refresh the unfinished task',
    summary:
      'Review current inputs under the approved plan and replace the unused stale recommendation. Completed work is preserved.',
  };
}
export function refreshRecommendation(service, issueId, actionId) {
  service.ownServer();
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === issueId),
    action = queue.actions.find((a) => a.id === actionId),
    record = service.lifecycleRuns[issueId];
  requireThat(
    issue && action && recommendationRefresh(queue, issue, action),
    'The saved task changed or already started. Refresh before continuing.'
  );
  const plan = approvedPlan(service.root, issueId);
  requireThat(record?.approval?.sha256 === plan.sha256, 'Continue under the current approved plan.');
  service.api.record(action.id, {
    status: 'cancelled',
    expected_recommendation: digest(JSON.stringify(action)),
    evidence:
      'Unused stale recommendation retired for fresh planning under approved plan ' +
      plan.sha256 +
      '. Original scope, base and history are retained.',
    summary: 'Superseded unused recommendation; replan only unfinished work.',
    authorization: planAuthorization(record, 'refresh-recommendation'),
  });
  saveLifecycle(service, record, { replan: true });
  lifecycleEvent(
    service,
    record,
    'Retired an unused stale recommendation. Reviewing the unfinished work under your approved plan.'
  );
  return {};
}
