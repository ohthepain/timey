import { proof, evidence } from '../issue-delivery-store.mjs';
import { requireThat, digest, readJson } from './common.mjs';
import { retainAnswer, saveLifecycle } from './lifecycle-store.mjs';

function publicationIdentity(service, delivery) {
  return digest(JSON.stringify({ request: service.deliveries.request(delivery), readiness: delivery.readiness }));
}
export function requestPublication(service, issueId) {
  const delivery = service.deliveries.inspect(issueId),
    context = service.deliveries.context(issueId);
  service.deliveries.requireReady(context, delivery);
  const record = service.lifecycleRuns[issueId];
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: 'The pull request is ready to open. Confirm publication of this issue branch.',
    input: {
      type: 'publication',
      repository: delivery.repository,
      source: delivery.source,
      target: delivery.target,
      candidate: delivery.candidate,
      identity: publicationIdentity(service, delivery),
    },
  });
  return {};
}
export async function publishIssue(service, record, input) {
  requireThat(record.input?.type === 'publication', 'This publication request is no longer waiting for approval.');
  requireThat(['approve', 'retry'].includes(input.decision), 'Approve publication or retry its saved approval.');
  const delivery = service.deliveries.inspect(record.issueId);
  requireThat(
    record.input.identity === publicationIdentity(service, delivery),
    'The pull request contents or checks changed. Review the current result before publishing.'
  );
  const context = service.deliveries.context(record.issueId);
  service.deliveries.requireReady(context, delivery);
  const approval = publicationApproval(service, record, delivery, input);
  const result = await service.deliveries.operate('open', { issueId: record.issueId, publication: approval });
  saveLifecycle(service, record, {
    input: null,
    deliveryPublished: result.pr,
    deliveryHandoff: result.mode === 'draft-handoff',
    ...(result.mode === 'draft-handoff' ? { status: 'finished', deliveryWaiting: false } : {}),
    summary:
      result.mode === 'draft-handoff'
        ? 'Handed off for manual repair and merge. The draft PR is open; acceptance and closure remain outstanding.'
        : 'The pull request is open. Its checks and merge controls are shown below.',
  });
}

function publicationApproval(service, record, delivery, input) {
  const saved = record.publicationApproval;
  if (saved?.identity === record.input.identity) {
    evidence(saved.receipt);
    const value = readJson(saved.receipt.path);
    requireThat(
      value.actor === 'human' && value.type === 'issue-pr-publication' && value.identity === saved.identity,
      'The saved publication approval is no longer valid.'
    );
    return saved.receipt;
  }
  requireThat(input.decision === 'approve', 'Approve this exact branch before its first publication.');
  const path = retainAnswer(service, record, {
    type: 'issue-pr-publication',
    operation: 'open-issue-pr',
    issueId: record.issueId,
    repository: delivery.repository,
    source: delivery.source,
    target: delivery.target,
    candidate: delivery.candidate,
    identity: record.input.identity,
  });
  const receipt = proof(path);
  saveLifecycle(service, record, { publicationApproval: { identity: record.input.identity, receipt } });
  return receipt;
}
