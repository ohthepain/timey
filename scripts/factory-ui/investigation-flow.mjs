import { readFileSync } from 'node:fs';
import { digest, requireThat } from './common.mjs';

import { inquiryKinds } from './flow-order.mjs';
export { inquiryKinds, investigationOutputKinds } from './flow-order.mjs';

function legacyGeneratedPrompt(block) {
  const { systemPrompt = '' } = block.attempts.at(-1) ?? {};
  return [
    /^(Run the agreed whole-project investigation\.|This turn is a preliminary investigation conversation\.)/.test(
      block.prompt
    ),
    String(systemPrompt).endsWith('\n\n' + block.prompt),
  ].every(Boolean);
}

export function isManagedInvestigationPrompt(block) {
  if (block.investigationPromptSha256) return block.investigationPromptSha256 === digest(block.prompt);
  return legacyGeneratedPrompt(block);
}

export function investigationAttempts(flow, kinds) {
  return flow.blocks
    .concat(flow.retiredBlocks ?? [])
    .filter(({ kind }) => kinds.has(kind))
    .flatMap((block) => block.attempts.map((attempt) => ({ block, attempt })));
}
function completedInquiry({ attempt }) {
  return attempt.status === 'completed' && attempt.investigation?.mode !== 'discussion';
}
function currentAttempt({ attempt }) {
  return !attempt.invalidatedAt && !attempt.cancelledByEdit;
}
function fallbackFindings(attempt) {
  return attempt.output || attempt.summary || '';
}
function retainedFindings(attempt) {
  const { artifacts = {} } = attempt;
  const { files = {} } = artifacts;
  if (!files.response) return fallbackFindings(attempt);
  const file = files.response;
  let bytes;
  try {
    bytes = readFileSync(file.path);
  } catch {
    throw Error('The retained investigation findings are unavailable.');
  }
  requireThat(file.sha256 && digest(bytes) === file.sha256, 'The retained investigation findings cannot be verified.');
  return bytes.toString('utf8');
}
function sourceRevision(flow, attempt) {
  const { investigation = {}, result = {} } = attempt;
  const previous = flow.investigationRunSources?.[attempt.id] ?? {};
  return [investigation, previous].map(({ startingPoint = {} }) => startingPoint.commit).find(Boolean) || result.head;
}
function oldFollowups(flow, attemptId) {
  return flow.blocks.flatMap(({ legacyFollowups = [] }) =>
    legacyFollowups
      .filter((entry) => entry.sourceAttemptId === attemptId)
      .flatMap((entry) => entry.followups.map((item) => ({ ...item, folder: entry.folder })))
  );
}
export function successfulInvestigationSource(flow, issueId, requestedAttemptId) {
  const inquiries = investigationAttempts(flow, inquiryKinds)
    .filter(completedInquiry)
    .sort((a, b) => String(a.attempt.startedAt).localeCompare(String(b.attempt.startedAt)));
  const selected = requestedAttemptId
    ? inquiries.find(({ attempt }) => attempt.id === requestedAttemptId)
    : inquiries.findLast(currentAttempt);
  requireThat(selected, 'Choose a successfully completed investigation run before running this output.');
  const { block, attempt } = selected;
  return {
    issueId,
    blockId: block.id,
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    revision: sourceRevision(flow, attempt),
    findings: retainedFindings(attempt),
    evidence: structuredClone(attempt.evidence ?? []),
    legacyFollowups: oldFollowups(flow, attempt.id),
  };
}
function reportSourceMatches(attempt, source) {
  return attempt.status === 'completed' && attempt.investigationSource?.attemptId === source.attemptId;
}
function reportFindings({ attempt }) {
  const { artifacts = {}, evidence = [] } = attempt;
  const { values = {} } = artifacts;
  return {
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    findings: values.additionalFindings ?? '',
    inspectedRevisions: values.inspectedRevisions ?? [],
    evidence: evidence.concat(values.reportEvidence ?? []),
  };
}
export function successfulReportFindings(flow, source) {
  return investigationAttempts(flow, new Set(['generate-report']))
    .filter(({ attempt }) => !attempt.cancelledByEdit)
    .filter(({ attempt }) => reportSourceMatches(attempt, source))
    .sort((a, b) => String(a.attempt.startedAt).localeCompare(String(b.attempt.startedAt)))
    .map(reportFindings);
}

function supplementalFactKey({ findings = '', inspectedRevisions = [] }) {
  return JSON.stringify([String(findings).trim(), [...new Set(inspectedRevisions)].sort()]);
}
export function supplementalFindingsSignature(findings) {
  const keys = findings.filter((entry) => String(entry.findings ?? '').trim()).map(supplementalFactKey);
  return digest(JSON.stringify([...new Set(keys)].sort()));
}
