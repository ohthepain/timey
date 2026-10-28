import { join } from 'node:path';
import { deliveryMode, draftHandoff } from './factory-ui/delivery-mode.mjs';
import { checkHandoff } from './factory-ui/handoff-checks.mjs';
import { requireThat, digest, readJson } from './factory-ui/common.mjs';
import { candidateUnchanged, currentContributions, completionStage } from './issue-delivery-policy.mjs';
import { evidence } from './issue-delivery-store.mjs';

export async function prepareDraftHandoff(service, store, context) {
  const delivery = store.read();
  requireThat(delivery && !delivery.pr, 'Collect contributions before preparing the draft PR handoff.');
  requireThat(
    deliveryMode(context.queue, context.issue, undefined, delivery.mode) === draftHandoff,
    'Preserve the explicitly selected delivery route.'
  );
  requireThat(
    context.config.repository === delivery.repository && context.config.target === delivery.target,
    'Delivery settings changed; reconcile the saved branch before handoff.'
  );
  requireThat(completionStage(context.queue, context.issue), 'Finish the current or custom stage before handing off.');
  candidateUnchanged(delivery);
  currentContributions(context.queue, delivery);
  requireThat(delivery.contributions.length, 'The draft PR needs an issue contribution.');
  const actions = context.queue.actions.filter((a) => a.issues.includes(context.issue.id));
  requireThat(
    !actions.some((a) => ['reserved', 'setup', 'running', 'completed'].includes(a.status)),
    'Wait for running work and retain all completed contributions before handoff.'
  );
  const previous = delivery.contributions.at(-1).handoffCheck;
  const checked =
    previous?.head === delivery.candidate && previous.base === delivery.originalBase
      ? previous
      : await checkHandoff(
          service.check,
          delivery.checkout,
          delivery.originalBase,
          join(store.directory, 'draft-handoff-checks-' + delivery.generation)
        );
  checked.evidence.forEach(evidence);
  requireThat(service.context(delivery.issueId).basis === context.basis, 'The issue changed during handoff checks.');
  const report = {
    mode: draftHandoff,
    plan: context.plan.sha256,
    candidate: delivery.candidate,
    summary:
      'Handed off for manual repair and merge. Implementation may be incomplete; acceptance and closure remain outstanding.',
    checks: {
      passed: checked.passed,
      failure: checked.failure,
      summaries: checked.summaries,
      commands: checked.commands || [],
    },
    work: workFindings(actions, delivery),
    humanChecks: context.issue.human_checks || [],
    approvedPlan: context.plan.content,
    evidence: checked.evidence,
  };
  const receipt = store.retain('draft-handoff-' + delivery.generation + '-' + digest(JSON.stringify(report)), report);
  return store.save({
    ...delivery,
    mode: draftHandoff,
    state: 'ready',
    readiness: {
      kind: draftHandoff,
      basis: context.basis,
      reportReceipt: receipt,
      evidence: [...checked.evidence, receipt],
      report,
    },
  });
}
export function requireDraftHandoff(context, delivery) {
  requireThat(
    delivery.mode === draftHandoff && delivery.readiness?.kind === draftHandoff,
    'Prepare the draft PR handoff first.'
  );
  requireThat(delivery.readiness.basis === context.basis, 'The draft PR handoff changed. Prepare the current result.');
  requireThat(
    delivery.readiness.report.candidate === delivery.candidate &&
      delivery.readiness.report.plan === context.plan.sha256,
    'The handoff scope changed.'
  );
  requireThat(
    deliveryMode(context.queue, context.issue, undefined, delivery.mode) === draftHandoff,
    'The selected delivery route changed.'
  );
  const actions = context.queue.actions.filter((a) => a.issues.includes(context.issue.id));
  requireThat(
    JSON.stringify(workFindings(actions, delivery)) === JSON.stringify(delivery.readiness.report.work),
    'Issue work changed after the handoff was prepared.'
  );
  evidence(delivery.readiness.reportReceipt);
  requireThat(
    digest(JSON.stringify(readJson(delivery.readiness.reportReceipt.path))) ===
      digest(JSON.stringify(delivery.readiness.report)),
    'The retained handoff report changed.'
  );
  candidateUnchanged(delivery);
  currentContributions(context.queue, delivery);
  delivery.readiness.evidence.forEach(evidence);
}
export function draftHandoffBody(report) {
  return `${report.summary}\n\nChecks: ${report.checks.passed ? 'The attempted checks passed.' : 'Failed or unavailable: ' + report.checks.failure}\n${(report.checks.commands || []).map((c) => '- ' + c.name + ': ' + (c.passed ? 'passed' : 'failed or unavailable') + ' (exit ' + c.exit + ')').join('\n')}\n\nApproved plan (completion is not asserted):\n${report.approvedPlan}\n\nWork and remaining findings:\n${report.work.map((a) => '- ' + a.actionId + ' (' + a.status + '): ' + a.scope + '\n' + readableFindings(a.evidence)).join('\n')}\n\nHuman checks, as recorded:\n${JSON.stringify(report.humanChecks)}\n\nNo automatic repair, rebase, CI maintenance, merge, acceptance or closure follows this handoff.`;
}

function workFindings(actions, delivery) {
  return actions.map((a) => {
    const contribution = delivery.contributions.find((c) => c.actionId === a.id);
    return {
      actionId: a.id,
      status: a.status,
      scope: a.scope || '',
      evidence: contribution?.findings || a.evidence || '',
      currentEvidence: a.evidence || '',
    };
  });
}

function readableFindings(text) {
  let result;
  try {
    result = JSON.parse(text.split(' Independent checks: ')[0]);
  } catch {
    return text;
  }
  return [
    result.summary || '',
    result.implementation_complete === false ? 'Implementation is incomplete.' : '',
    ...(result.remaining || []).map((item) => '- Remaining: ' + item),
    typeof result.evidence === 'string' ? result.evidence : '',
  ]
    .filter(Boolean)
    .join('\n');
}
