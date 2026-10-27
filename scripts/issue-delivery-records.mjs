import { join } from 'node:path';
import { readJson, requireThat, digest } from './factory-ui/common.mjs';
import { evidence, DeliveryStore } from './issue-delivery-store.mjs';

export function assembledContribution(root, action) {
  requireThat(action.issues.length === 1, 'Grouped candidates require scoped allocation before delivery.');
  const store = new DeliveryStore(root, action.issues[0]),
    delivery = store.read();
  const contribution = delivery?.contributions.find((c) => c.actionId === action.id);
  requireThat(contribution, 'Record durable assembly evidence before releasing the claim.');
  const expected = join(store.directory, 'assembly-' + action.id + '.json');
  requireThat(contribution.receipt.path === expected, 'Assembly receipt identity changed.');
  evidence(contribution.receipt);
  const receipt = readJson(expected);
  requireThat(
    receipt.workerRevision === action.worker_revision &&
      receipt.originalBase === (action.start?.revision || action.basis.head) &&
      receipt.merge === action.merge,
    'Assembly authority or candidate changed.'
  );
  receipt.evidence.forEach(evidence);
  return contribution;
}
export function verifiedIssueDelivery(root, issueId) {
  const delivery = new DeliveryStore(root, issueId).read();
  requireThat(
    delivery?.state === 'verified' && delivery.pr?.id && delivery.pr?.url && delivery.merge?.revision,
    'A verified issue PR delivery is required; direct-delivery assertions are disabled.'
  );
  evidence(delivery.integration);
  const receipt = readJson(delivery.integration.path);
  requireThat(
    digest(JSON.stringify(receipt.pr)) === digest(JSON.stringify(delivery.pr)) &&
      receipt.merge.revision === delivery.merge.revision,
    'Integration receipt identity changed.'
  );
  receipt.evidence.forEach(evidence);
  return delivery;
}
export function validateAssembledStart(root, action, data) {
  const start = action.start;
  requireThat(
    start?.issueId && start?.revision && start?.approval,
    'An assembled dependency needs an exact approved issue-branch starting revision.'
  );
  requireThat(
    action.issues.length === 1 && action.issues[0] === start.issueId,
    'Progress cannot consume another issue’s undelivered assembly.'
  );
  evidence(start.approval);
  const approval = readJson(start.approval.path),
    delivery = new DeliveryStore(root, start.issueId).read();
  requireThat(
    delivery?.candidate === start.revision &&
      approval.actor === 'human' &&
      approval.operation === 'start-assembled-work' &&
      approval.revision === start.revision &&
      approval.issueId === start.issueId,
    'The approved assembled starting revision changed.'
  );
  requireThat(
    action.dependencies.every(
      (id) =>
        data.actions.find((a) => a.id === id)?.status !== 'assembled' ||
        delivery.contributions.some((c) => c.actionId === id)
    ),
    'Dependency is outside this delivery.'
  );
  return start.revision;
}
