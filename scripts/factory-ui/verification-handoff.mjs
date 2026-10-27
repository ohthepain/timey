import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';
import { DeliveryStore } from '../issue-delivery-store.mjs';
import { planAuthorization } from '../factory-authorization.mjs';
import { approvedPlan } from '../issue-delivery-policy.mjs';
import { requireThat, git } from './common.mjs';
import { readQueue } from './data.mjs';

export function verificationHandoff(queue, issue, actions) {
  const action = actions.find(
    (a) =>
      a.status === 'recommended' &&
      a.kind === 'verify' &&
      a.merge === 'none' &&
      !a.start &&
      a.issues.length === 1 &&
      a.dependencies.some((id) => queue.actions.find((p) => p.id === id)?.status === 'assembled')
  );
  if (!action) return null;
  const delivery = new DeliveryStore(queue.root, issue.id).read();
  if (!delivery?.candidate) return null;
  return {
    kind: 'bind-verification',
    actionId: action.id,
    candidate: delivery.candidate,
    title: 'Verify the saved issue branch',
    summary:
      'Use the saved issue revision for the verification task, then run it. Implementation and the existing merge will not be repeated.',
  };
}
export function bindVerification(service, actionId, candidate) {
  service.ownServer();
  const queue = readQueue(service.root),
    action = queue.actions.find((a) => a.id === actionId);
  requireThat(action, 'The saved verification task is missing.');
  const record = service.lifecycleRuns[action.issues[0]],
    plan = approvedPlan(service.root, action.issues[0]);
  requireThat(record?.approval?.sha256 === plan.sha256, 'Verify under the current approved issue plan.');
  service.guard(service.root, action, 'verify', queue.head);
  service.api.bindVerification(actionId, candidate, planAuthorization(record, 'bind-verification'));
  saveLifecycle(service, record, { replan: false });
  lifecycleEvent(service, record, 'Verification is connected to the saved issue revision. Starting its existing task.');
  return {};
}

export function verificationBranchBasis(queue, issue) {
  if (
    !queue.actions.some(
      (a) =>
        a.kind === 'verify' &&
        a.status === 'recommended' &&
        a.issues.includes(issue.id) &&
        a.dependencies.some((id) => queue.actions.find((p) => p.id === id)?.status === 'assembled')
    )
  )
    return null;
  const delivery = new DeliveryStore(queue.root, issue.id).read();
  if (!delivery) return null;
  try {
    return {
      candidate: delivery.candidate,
      plan: delivery.plan,
      generation: delivery.generation,
      head: git(delivery.checkout, 'rev-parse', 'HEAD'),
      dirty: git(delivery.checkout, 'status', '--porcelain'),
    };
  } catch {
    return { candidate: delivery.candidate, unavailable: true };
  }
}
