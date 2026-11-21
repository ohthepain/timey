import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inquiryKinds, investigationAttempts } from './investigation-flow.mjs';

function savedRecords(directory, pattern) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}
export function savedInvestigationSessions(root, issueId) {
  const directory = join(root, '.issues/factory-ui/project-home/investigations');
  return savedRecords(directory, /^[a-f0-9-]{36}\.json$/).filter((session) => session.issueId === issueId);
}
export function savedInvestigationFollowups(root, issueId) {
  const directory = join(root, '.issues/flows/investigation-followups');
  return savedRecords(directory, /^[a-f0-9]{64}\.json$/).filter((receipt) => receipt.source.issueId === issueId);
}
const unresolved = (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status);
const all = (checks) => checks.every(Boolean);
function hasCustomization(block) {
  const {
    edits = [],
    comments = [],
    inputs = {},
    skillExplicit,
    skill,
    lane = 0,
    iterations = 1,
    suggested = false,
  } = block;
  return [
    edits.length,
    comments.length,
    Object.keys(inputs).length,
    skillExplicit,
    skill,
    lane !== 0,
    iterations !== 1,
    suggested,
  ].some(Boolean);
}
function originalDefinition(block, original) {
  return ['definitionChecksum', 'declaredDetails', 'declaredArtifacts'].every((key, index) => {
    const expected = [original.checksum, original.details, original.artifacts][index];
    return !block[key] || JSON.stringify(block[key]) === JSON.stringify(expected);
  });
}
function standardLinks(block, requestId, original) {
  const keys = new Set(original.details.filter(({ source }) => source.startsWith('Request.')).map(({ key }) => key));
  return Object.entries(block.links ?? {}).every(([key, id]) => id === requestId && keys.has(key));
}
function managedPrompt(flow, block) {
  if (!flow.projectInvestigation) return false;
  return /^(Run the agreed whole-project investigation\.|This turn is a preliminary investigation conversation\.)/.test(
    block.prompt
  );
}
function standardInquiry(block, request, catalog, managed) {
  const original = catalog.find(({ id }) => id === 'understand');
  return all([
    block.kind === 'understand',
    !block.definition,
    block.label === 'Understand',
    block.after.length === 1,
    block.after[0] === request.id,
    !block.prompt || managed,
    !hasCustomization(block),
    standardLinks(block, request.id, original),
    originalDefinition(block, original),
  ]);
}
function standardLayout(flow) {
  const { definition = {} } = flow;
  return all([flow.investigationLayout !== 2, flow.blocks.length === 2, definition.id === 'investigation']);
}
function standardRequest(request, catalog) {
  const original = catalog.find(({ id }) => id === 'request');
  return all([
    request.kind === 'request',
    request.label === original.label,
    !request.definition,
    !request.after.length,
    !request.prompt,
    !hasCustomization(request),
    !Object.keys(request.links ?? {}).length,
    originalDefinition(request, original),
  ]);
}
function idleHistory(flow, sessions) {
  return all([
    !investigationAttempts(flow, inquiryKinds).some(({ attempt }) => unresolved(attempt)),
    !flow.blocks.flatMap(({ attempts }) => attempts).some(unresolved),
    !sessions.some(({ status }) => ['running', 'stopping', 'interrupted'].includes(status)),
  ]);
}
function mayAdopt(flow, catalog, sessions) {
  if (!standardLayout(flow)) return false;
  const [request, inquiry] = flow.blocks;
  return all([
    standardRequest(request, catalog),
    standardInquiry(inquiry, request, catalog, managedPrompt(flow, inquiry)),
    idleHistory(flow, sessions),
  ]);
}
function legacySession(session) {
  return all([session.mode !== 'discussion', session.attemptId, session.followupSource]);
}
function sessionReceipt(session) {
  return {
    sourceAttemptId: session.attemptId,
    sessionId: session.id,
    followupSource: session.followupSource,
    followupBasis: session.followupBasis,
    followups: session.followups ?? [],
    folder: session.folder,
  };
}
function completedInquiry(attempt) {
  return attempt.status === 'completed' && attempt.investigation?.mode !== 'discussion';
}
function historicalCompletion(inquiry, old) {
  const latest = inquiry.attempts.findLast(completedInquiry) ?? {};
  const finished = old.find((session) => session.attemptId === latest.id && session.status === 'completed');
  if (!finished) return undefined;
  const { followups = [] } = finished;
  return {
    sourceAttemptId: finished.attemptId,
    sessionId: finished.id,
    issueIds: followups.filter(({ issueId, error }) => issueId && !error).map(({ issueId }) => issueId),
    completedAt: finished.updatedAt,
  };
}
function successfulProposal(proposal) {
  return Boolean(proposal.result?.issueId) && !proposal.error && !proposal.result.deleted;
}
function completedManualReceipt(inquiry, receipts) {
  const latest = inquiry.attempts.findLast(completedInquiry) ?? {};
  const source = receipts.filter(({ source }) => source.attemptId === latest.id);
  const complete = source.find(({ proposals }) => proposals.length > 0 && proposals.every(successfulProposal));
  if (!complete) return undefined;
  return {
    sourceAttemptId: latest.id,
    receiptBasis: complete.source.basis,
    issueIds: complete.proposals.map(({ result }) => result.issueId),
  };
}
function sessionSources(sessions) {
  return Object.fromEntries(
    sessions
      .filter(({ attemptId }) => attemptId)
      .map((session) => [
        session.attemptId,
        {
          startingPoint: session.startingPoint,
          settings: session.settings,
          prompt: session.prompt,
          mode: session.mode,
        },
      ])
  );
}
export function adoptInvestigationFlow(flow, catalog, sessions, createBlock, receipts = []) {
  if (!mayAdopt(flow, catalog, sessions)) return false;
  const definition = catalog.find(({ id }) => id === 'investigate');
  if (!definition) return false;
  const inquiry = flow.blocks[1];
  Object.assign(inquiry, {
    legacyKind: 'understand',
    kind: 'investigate',
    label: definition.label,
    definitionChecksum: definition.checksum,
    declaredDetails: definition.details,
    declaredArtifacts: definition.artifacts,
    flowKey: 'work',
  });
  const report = createBlock('generate-report', [inquiry.id], false, catalog);
  report.id = report.flowKey = 'generate-report';
  const issues = createBlock('create-issues', [inquiry.id], false, catalog);
  issues.id = issues.flowKey = 'create-issues';
  const old = sessions.filter(legacySession);
  issues.legacyFollowups = old.map(sessionReceipt);
  issues.historicalCompletion = historicalCompletion(inquiry, old) || completedManualReceipt(inquiry, receipts);
  flow.investigationRunSources = sessionSources(sessions);
  flow.blocks.push(report, issues);
  flow.investigationLayout = 2;
  return true;
}
export function historicalInvestigationOutputComplete(block, flow) {
  if (!block.historicalCompletion) return false;
  const inquiry = flow.blocks.find(({ kind }) => inquiryKinds.has(kind)) ?? { attempts: [] };
  const latest = inquiry.attempts.findLast((attempt) => !attempt.cancelledByEdit) ?? {};
  return all([
    latest.status === 'completed',
    !latest.invalidatedAt,
    latest.id === block.historicalCompletion.sourceAttemptId,
    !block.attempts.length,
  ]);
}
