import { readFileSync, mkdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { recordStage } from './factory-ui/lifecycle.mjs';
import { requireThat } from './factory-ui/common.mjs';
import { describeAuthorization } from './factory-authorization.mjs';
export function appendCompletion(root, issue, result, run, evidence, target) {
  const path = join(root, '.issues', issue.id + '.md'),
    lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  try {
    const content = readFileSync(path, 'utf8');
    requireThat(
      content === issue.content,
      'The issue changed before its result could be recorded. Refresh and review again.'
    );
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    requireThat(match, 'The report frontmatter is missing.');
    const doc = parseDocument(match[1]);
    requireThat(!doc.errors.length, 'The report frontmatter is invalid.');
    doc.set('updated', new Date().toISOString());
    recordChecklistMetadata(doc, issue, result);
    recordInterviewMetadata(doc, result);
    recordAcceptedMetadata(doc, result);
    recordClosureMetadata(doc, result);
    if (target) doc.set('state', target);
    recordStage(doc, issue, target, result, run, evidence);
    const notes = `\n\n## ${reviewHeading(result)} — ${new Date().toISOString()}\n\n${result.summary}\n\n${result.notes}\n\n${recordedBy(run)}\n\nEvidence:\n${formatReviewEvidence(evidence)}\n\nRemaining work:\n${result.remaining.map((text) => '- ' + text).join('\n') || 'No additional task identified by this review. Human acceptance remains separate.'}\n${transitionNote(issue, target, result)}`;
    const next = '---\n' + doc.toString() + '---' + content.slice(match[0].length) + notes;
    const temp = join(dirname(path), '.review-' + randomUUID() + '.tmp');
    writeFileSync(temp, next, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

function recordedBy(run) {
  return (
    describeAuthorization(run.authorization) +
    (run.threadId ? ` Coordinator chat ${run.threadId}.` : '') +
    (run.actionId ? ` Assignment ${run.actionId}.` : '')
  );
}
function reviewHeading(result) {
  if (result.stage_grilling) return 'Grilling · ' + result.stage_grilling.name;
  return ordinaryReviewHeading(result);
}
function ordinaryReviewHeading(result) {
  if (result.plan_verification) return 'Implementation checklist';
  if (result.user_decision) return 'Issue decision';
  return result.stage_records ? 'Issue progress review' : 'Worker result review';
}
function recordChecklistMetadata(doc, issue, result) {
  recordDeliveryMetadata(doc, result);
  if (result.record_update)
    doc.set('record_update', doc.createNode(result.record_update, { aliasDuplicateObjects: false }));
  if (result.plan_verification)
    doc.set('plan_verification', doc.createNode(result.plan_verification, { aliasDuplicateObjects: false }));
  if (result.human_check_update) {
    const index = issue.human_checks.findIndex((check) => check.id === result.human_check_update.id);
    doc.setIn(['human_checks', index], doc.createNode(result.human_check_update, { aliasDuplicateObjects: false }));
  }
}

function formatReviewEvidence(evidence) {
  const proof = evidence.filter((entry) => entry.kind !== 'instruction');
  const instructions = evidence.filter((entry) => entry.kind === 'instruction');
  return (
    proof.map((entry) => '- ' + entry.path + ' (sha256:' + entry.sha256 + ')').join('\n') +
    (instructions.length
      ? '\n\nInstructions read (retained copies, not test results):\n' +
        instructions
          .map((entry) => '- ' + entry.source + ' → ' + entry.path + ' (sha256:' + entry.sha256 + ')')
          .join('\n')
      : '')
  );
}

function recordDeliveryMetadata(doc, result) {
  if (!result.delivery) return;
  doc.set('delivery', doc.createNode(result.delivery, { aliasDuplicateObjects: false }));
  doc.delete('record_update');
}

function recordAcceptedMetadata(doc, result) {
  if (result.accepted_result)
    doc.set('accepted_result', doc.createNode(result.accepted_result, { aliasDuplicateObjects: false }));
}

function recordInterviewMetadata(doc, result) {
  if (result.stage_grilling) {
    const history = doc.get('stage_grilling')?.toJSON() || [];
    requireThat(Array.isArray(history), 'Saved stage interviews are invalid; preserve them before recording.');
    doc.set('stage_grilling', doc.createNode([...history, result.stage_grilling], { aliasDuplicateObjects: false }));
  }
}

function recordClosureMetadata(doc, result) {
  if (result.closure) {
    doc.set('closure', doc.createNode(result.closure));
    if (result.closure.reason !== 'fixed') doc.delete('accepted_result');
  }
  if (result.user_decision === 'reopen') doc.delete('closure');
}

function transitionNote(issue, target, result) {
  if (!target) return '';
  if (closedWithoutFix(result))
    return `\nIssue closed from ${issue.state} by explicit user decision. Unfinished work was not completed or verified.\n`;
  return '\nStage advanced from ' + issue.state + ' to ' + target + ' after review of its exit condition.\n';
}

function closedWithoutFix(result) {
  return result.closure?.reason !== undefined && result.closure.reason !== 'fixed';
}
