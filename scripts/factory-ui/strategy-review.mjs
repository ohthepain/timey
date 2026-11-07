import { join } from 'node:path';
import { git, requireThat, writeJson, readJson } from './common.mjs';
import { saveLifecycle, lifecycleEvent } from './lifecycle-store.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'should', 'nit'] },
          detail: { type: 'string' },
        },
        required: ['id', 'severity', 'detail'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
};
function priorReview(work, run) {
  return work.review?.runId === run.id ? work.review : null;
}

function alreadyReviewed(work, prior) {
  if (!prior) return false;
  return prior.approvedHead === git(work.checkout, 'rev-parse', 'HEAD');
}

function requireReviewBudget(work, prior) {
  if (!prior) return;
  requireThat(
    prior.rounds < work.solRounds,
    'Sol Loop reached its round budget. The repaired candidate needs an explicitly authorized further review.'
  );
}

async function selectReviewer(service) {
  await service.codex.ready();
  const available = await service.codex.call('model/list', { limit: 100 });
  const models = (available.data || []).filter((model) => /\bsol\b/i.test(model.id + ' ' + model.displayName));
  models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  requireThat(models.length, 'Sol Loop was requested, but no Sol model is available. No substitute reviewer was used.');
  return models[0].id;
}

async function reviewerThread(service, work, prior) {
  if (!prior) return service.codex.start(work.checkout, 'read-only');
  await service.codex.unarchive(prior.threadId);
  await service.codex.resume(prior.threadId, work.checkout, 'read-only');
  return prior.threadId;
}

async function nameReviewer(context) {
  const { service, issue, threadId } = context;
  try {
    await service.codex.call(
      'thread/name/set',
      { threadId, name: (issue.title || issue.id) + ' · Sol review' },
      null,
      2000
    );
  } catch {}
}

function reviewPrompt(context, head, round) {
  const { service, issue, work, ledger } = context;
  const scope = round === 1 ? 'Review the full scoped change.' : 'Review changed code and open findings only.';
  return `Review only. Do not edit, commit, push, approve permissions, start subagents or merge. Issue: ${service.root}/.issues/${issue.id}.md. Base: ${work.base}. Candidate: ${head}. Read git diff ${work.base} and surrounding code. Review the original feature and necessary blocker repairs; minimize changes and decline unrelated improvements. One reviewer; no nested reviewers. ${scope} Ledger: ${JSON.stringify(ledger)}. Return stable finding IDs, severity and evidence. Approve only the current behavior diff with no blocker or should findings. Nits alone do not require another round.`;
}

async function observeReview(context, round) {
  const { service, record, run, work, threadId, model, ledger } = context;
  const head = git(work.checkout, 'rev-parse', 'HEAD');
  lifecycleEvent(service, record, `Sol review ${round}/${work.solRounds}.`);
  service.store.update(run, { threadId });
  context.idle = false;
  const text = await service.codex.turn(threadId, work.checkout, reviewPrompt(context, head, round), schema, [], {
    model,
    effort: 'medium',
  });
  context.idle = true;
  const result = JSON.parse(text);
  requireThat(git(work.checkout, 'rev-parse', 'HEAD') === head, 'Candidate changed during Sol review.');
  ledger.push({ round, model, head, ...result });
  const path = join(service.store.directory, run.id, 'sol-review.json');
  writeJson(path, ledger);
  work.review = { runId: run.id, model, threadId, rounds: round, ledger: path };
  saveLifecycle(service, record);
  return { head, result, open: result.findings.filter((finding) => finding.severity !== 'nit') };
}

function approvedReview(review) {
  return !review.open.length && (review.result.verdict === 'approve' || review.result.findings.length);
}

async function reviewRounds(context, ownerTurn) {
  const { service, record, run, issue, work, ledger } = context;
  for (let round = ledger.length + 1; round <= work.solRounds; round++) {
    const review = await observeReview(context, round);
    if (approvedReview(review)) {
      work.review.approvedHead = review.head;
      saveLifecycle(service, record);
      service.store.update(run, { threadId: record.workThreadId });
      return;
    }
    requireThat(review.open.length, 'Sol did not approve or provide an actionable finding. Review its saved result.');
    await ownerTurn(
      service,
      record,
      run,
      issue,
      `Address these Sol findings with minimal fixes and focused proof. Do not repeat completed work. If you disagree, give concrete evidence and preserve the finding for the next review. Findings: ${JSON.stringify(review.open)}. Update the issue PR; do not merge. The review budget is ${work.solRounds} round(s).`
    );
  }
  throw Error(
    `Sol Loop reached its ${work.solRounds}-round budget. Findings and the latest candidate are retained; further review needs your decision.`
  );
}

async function archiveReviewer(context) {
  if (!context.idle) return;
  const { service, run, threadId } = context;
  try {
    await service.codex.call('thread/archive', { threadId }, null, 2000);
  } catch (error) {
    service.store.update(run, { reviewArchiveError: error.message });
  }
}

export async function runSolLoop(service, record, run, issue, ownerTurn) {
  const work = record.work;
  const prior = priorReview(work, run);
  if (alreadyReviewed(work, prior)) return;
  requireReviewBudget(work, prior);
  const model = await selectReviewer(service);
  const threadId = await reviewerThread(service, work, prior);
  service.store.update(run, { reviewThreadId: threadId, reviewModel: model });
  const ledger = prior ? readJson(prior.ledger) : [];
  const context = { service, record, run, issue, work, model, threadId, ledger, idle: true };
  await nameReviewer(context);
  try {
    await reviewRounds(context, ownerTurn);
  } finally {
    await archiveReviewer(context);
  }
}
