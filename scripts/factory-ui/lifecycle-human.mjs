import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { inspectHumanInput } from './guard.mjs';
import { readQueue } from './data.mjs';
import { cleanEnvironment, digest, requireThat, writeJson } from './common.mjs';
import { saveLifecycle, retainAnswer } from './lifecycle-store.mjs';
import { lifecycleReview } from './lifecycle-review.mjs';

import { appendReview } from './review-result.mjs';

export function pauseForHuman(service, record, operation, transition = {}, action = { issues: [record.issueId] }) {
  const queue = readQueue(service.root);
  const read = inspectHumanInput(service.root, action, operation, queue.head, transition);
  const issue = read.result.issues[0];
  const blocker = issue.blockers.find((b) => issue.requests.some((r) => r.source_key === b.source_key));
  if (!blocker) return false;
  const request = issue.requests.find((r) => r.source_key === blocker.source_key);
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: 'Your input is needed to continue.',
    input: { type: 'human', request, operation, transition, actionId: action.id, reportDigest: issue.report_digest },
  });
  return true;
}
export function blockedHumanInput(service, record) {
  const queue = readQueue(service.root),
    issue = queue.issues.find((i) => i.id === record.issueId);
  const stage = queue.lifecycle.find((s) => s.state === issue.state);
  const operation = {
    'ready-for-grilling': 'investigate',
    'ready-for-repro': 'investigate',
    'ready-to-prototype': 'prototype',
    'ready-to-fix': 'implement',
    'ready-to-verify': 'verify',
    'ready-for-commit': 'commit',
  }[stage?.role];
  if (operation && pauseForHuman(service, record, operation)) return true;
  return pauseAtTransition(service, record, stage);
}
const answerSchema = {
  type: 'object',
  properties: { complete: { type: 'boolean' }, summary: { type: 'string' }, reason: { type: 'string' } },
  required: ['complete', 'summary', 'reason'],
  additionalProperties: false,
};
export async function answerHumanRequirement(service, record, input) {
  requireAnswerText(input.text);
  const queue = readQueue(service.root),
    saved = record.input;
  const action = queue.actions.find((a) => a.id === saved.actionId) || { issues: [record.issueId] };
  const read = inspectHumanInput(service.root, action, saved.operation, queue.head, saved.transition);
  const issue = read.result.issues[0];
  requireThat(issue.report_digest === saved.reportDigest, 'This issue changed. Refresh the question before answering.');
  const request = issue.requests.find((r) => r.source_key === saved.request.source_key);
  requireThat(request, 'This request no longer exists.');
  const answer = retainAnswer(service, record, { type: 'human-input', request, answer: input.text });
  const review = await lifecycleReview(
    service,
    record,
    `Review the actual human answer for this exact request. Does it fully supply the expected contribution for its CURRENT scope? A generic yes, partial answer or unrelated answer cannot cover missing observations. Do not decide on behalf of the human. Request ${JSON.stringify(request)}. Report digest ${issue.report_digest}. Actual human answer ${JSON.stringify(input.text)}.`,
    answerSchema
  );
  requireThat(review.result.complete, review.result.reason || 'This answer leaves part of the question unanswered.');
  const current = inspectHumanInput(service.root, action, saved.operation, queue.head, saved.transition);
  requireThat(
    current.result.issues[0].report_digest === issue.report_digest,
    'The issue changed during answer review. No answer was applied.'
  );
  if (request.authority === 'human_input') applyNativeAnswer(service, current, request, input.text, answer, review);
  else recordOwnedAnswer(service, record, request, input, answer, queue);
}
function applyNativeAnswer(service, read, request, text, answer, review) {
  const id = request.source_key.slice('human_input:'.length),
    at = new Date().toISOString();
  const update = {
    guard: request.guard,
    action: 'resolve',
    event: {
      id: 'answer-' + randomUUID(),
      type: 'answered',
      actor: 'human',
      at,
      summary: text,
      evidence_refs: [answer],
    },
    outcome: {
      type: 'human-answer',
      summary: text,
      actor: 'human',
      evidence_refs: [answer],
      scope: request.scope,
      covers: [id],
      delegation: null,
    },
    semantic_review: {
      reviewer: 'agent',
      evidence_ref: review.receipt,
      report_digest: read.result.issues[0].report_digest,
      scope: request.scope,
      verdict: 'applicable',
      reason: review.result.reason,
    },
  };
  const context = join(service.store.directory, randomUUID() + '-context.json'),
    intent = join(service.store.directory, randomUUID() + '-intent.json');
  writeJson(context, read.context);
  writeJson(intent, { protocol: read.context.protocol, operation_id: randomUUID(), updates: [update] });
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [read.helper, 'apply', '--project', service.root, '--context', context, '--intent', intent],
      { encoding: 'utf8', env: cleanEnvironment() }
    )
  );
  requireThat(!result.diagnostics?.length, 'The answer could not be applied. Its original contents are saved.');
}
function recordOwnedAnswer(service, record, request, input, answer, queue) {
  requireThat(request.authority === 'human_checks', 'This decision needs its dedicated approval button below.');
  requireThat(input.decision === 'approve', 'A failed check remains open until the requested changes are addressed.');
  const issue = queue.issues.find((i) => i.id === record.issueId),
    id = request.source_key.slice('human_checks:'.length);
  const check = issue.human_checks.find((c) => c.id === id);
  requireThat(check && check.blocks !== 'closure', 'Final acceptance is recorded at Final review.');
  const run = { id: randomUUID(), kind: 'decision' };
  const result = {
    outcome: 'completed',
    summary: 'Your result was recorded.',
    notes: input.text,
    remaining: [],
    evidence: [answer],
    next_state: null,
    human_check_update: {
      ...check,
      status: 'passed',
      revision: queue.head,
      result: input.text,
      evidence_refs: [answer],
    },
  };
  appendReview(service.root, issue, result, run, [{ path: answer, sha256: digest(readFileSync(answer)) }], null);
}

function pauseAtTransition(service, record, stage) {
  if (!stage?.next) return false;
  return pauseForHuman(service, record, 'advance', { target_state: stage.next });
}

function requireAnswerText(text) {
  requireThat(typeof text === 'string' && text.trim(), 'Enter your answer before continuing.');
}
