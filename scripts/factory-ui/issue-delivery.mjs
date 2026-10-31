import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { digest, requireThat, writeJson } from './common.mjs';
import { proof } from '../issue-delivery-store.mjs';

function basis(service, issueId) {
  return digest(
    JSON.stringify({
      context: service.deliveries.context(issueId).basis,
      delivery: service.deliveries.inspect(issueId),
    })
  );
}
export function prepareIssueDelivery(service, kind, input) {
  requireThat(
    ['assemble', 'handoff', 'ready', 'open', 'refresh', 'merge', 'reconcile', 'verify'].includes(kind),
    'Select a delivery operation.'
  );
  const delivery = service.deliveries.inspect(input.issueId);
  const token = randomUUID();
  service.intents.set(token, {
    delivery: true,
    kind,
    input,
    basis: basis(service, input.issueId),
    expires: Date.now() + 600000,
  });
  return {
    token,
    kind,
    delivery,
    fingerprint: delivery ? digest(JSON.stringify(service.deliveries.request(delivery))) : null,
    requiresApproval: kind === 'merge' && delivery?.contributions.some((c) => c.merge === 'human-first'),
  };
}
export async function startIssueDelivery(service, token, humanApproved) {
  service.ownServer();
  const intent = service.intents.get(token);
  requireThat(intent?.delivery && intent.expires > Date.now(), 'Review the current issue delivery again.');
  service.intents.delete(token);
  requireThat(intent.basis === basis(service, intent.input.issueId), 'Issue delivery changed after review.');
  const input = { ...intent.input },
    delivery = service.deliveries.inspect(input.issueId);
  if (intent.kind === 'merge' && delivery.contributions.some((c) => c.merge === 'human-first')) {
    requireThat(humanApproved === true, 'Approve the exact aggregate candidate and target before merging.');
    const path = join(service.store.directory, 'issue-merge-approval-' + token + '.json');
    writeJson(path, {
      actor: 'human',
      operation: 'merge-issue-pr',
      issueId: input.issueId,
      fingerprint: digest(JSON.stringify(service.deliveries.request(delivery))),
    });
    input.approval = proof(path);
  }
  return service.deliveries.operate(intent.kind, input);
}
