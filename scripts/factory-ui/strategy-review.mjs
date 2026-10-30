import { join } from 'node:path';
import { git, requireThat, writeJson } from './common.mjs';
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
export async function runSolLoop(service, record, run, issue, ownerTurn) {
  const work = record.work;
  await service.codex.ready();
  const available = await service.codex.call('model/list', { limit: 100 });
  const models = (available.data || []).filter((model) => /\bsol\b/i.test(model.id + ' ' + model.displayName));
  models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  requireThat(models.length, 'Sol Loop was requested, but no Sol model is available. No substitute reviewer was used.');
  const model = models[0].id;
  const reviewThreadId = await service.codex.start(work.checkout, 'read-only');
  service.store.update(run, { reviewThreadId, reviewModel: model });
  let reviewIdle = true;
  try {
    await service.codex.call(
      'thread/name/set',
      { threadId: reviewThreadId, name: (issue.title || issue.id) + ' · Sol review' },
      null,
      2000
    );
  } catch {}
  const ledger = [];
  try {
    for (let round = 1; round <= work.solRounds; round++) {
      const head = git(work.checkout, 'rev-parse', 'HEAD');
      lifecycleEvent(service, record, `Sol review ${round}/${work.solRounds}.`);
      service.store.update(run, { threadId: reviewThreadId });
      reviewIdle = false;
      const text = await service.codex.turn(
        reviewThreadId,
        work.checkout,
        `Review only. Do not edit, commit, push, approve permissions, start subagents or merge. Issue: ${service.root}/.issues/${issue.id}.md. Base: ${work.base}. Candidate: ${head}. Read git diff ${work.base} and surrounding code. Find in-scope behavior bugs; minimize changes and decline scope expansion. One reviewer; no nested reviewers. ${round === 1 ? 'Review the full scoped change.' : 'Review changed code and open findings only.'} Ledger: ${JSON.stringify(ledger)}. Return stable finding IDs, severity and evidence. Approve only the current behavior diff with no blocker or should findings. Nits alone do not require another round.`,
        schema,
        [],
        { model, effort: 'medium' }
      );
      reviewIdle = true;
      const result = JSON.parse(text);
      requireThat(git(work.checkout, 'rev-parse', 'HEAD') === head, 'Candidate changed during Sol review.');
      ledger.push({ round, model, head, ...result });
      writeJson(join(service.store.directory, run.id, 'sol-review.json'), ledger);
      work.review = {
        model,
        threadId: reviewThreadId,
        rounds: round,
        ledger: join(service.store.directory, run.id, 'sol-review.json'),
      };
      saveLifecycle(service, record);
      const open = result.findings.filter((finding) => finding.severity !== 'nit');
      if (!open.length && (result.verdict === 'approve' || result.findings.length)) {
        service.store.update(run, { threadId: record.workThreadId });
        return;
      }
      requireThat(open.length, 'Sol did not approve or provide an actionable finding. Review its saved result.');
      await ownerTurn(
        service,
        record,
        run,
        issue,
        `Address only these in-scope Sol findings, with minimal fixes and focused proof. Do not repeat completed work. If you disagree, give concrete evidence and preserve the finding for the next review. Findings: ${JSON.stringify(open)}. Update the same PR; do not merge. The review budget is ${work.solRounds} round(s).`
      );
    }
    throw Error(
      `Sol Loop reached its ${work.solRounds}-round budget. Findings and the latest candidate are retained; further review needs your decision.`
    );
  } finally {
    if (reviewIdle) {
      try {
        await service.codex.call('thread/archive', { threadId: reviewThreadId }, null, 2000);
      } catch (error) {
        service.store.update(run, { reviewArchiveError: error.message });
      }
    }
  }
}
