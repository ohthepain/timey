import { requireThat, digest } from './common.mjs';
import { isInvestigation } from './investigation-records.mjs';
import {
  inquiryKinds,
  isManagedInvestigationPrompt,
  investigationOutputKinds,
  successfulInvestigationSource,
  successfulReportFindings,
  supplementalFindingsSignature,
} from './investigation-flow.mjs';
import { invalidateBlocks, requestData, latestCurrentAttempt } from './flow-block-data.mjs';
import { activeGroupRequest, groupScope } from './flow-group-scope.mjs';
import { branchStartingPoint, flowBranches } from './flow-branches.mjs';
import { requireValidExecutionSettings } from './issue-execution-settings.mjs';

function requireOwningSession(owner, input) {
  if (!input.investigationOperation) return;
  requireThat(
    owner.investigations?.active.has(input.investigationOperation),
    'The investigation operation is no longer active.'
  );
}
export function requireInvestigationBlock(owner, issue, flow, input) {
  if (!isInvestigation(issue, flow) || flow.closing) return;
  requireOwningSession(owner, input);
  const selected = flow.blocks.find(({ id }) => id === input.blockId);
  const allowed = new Set([...inquiryKinds, ...investigationOutputKinds]);
  requireThat(
    allowed.has(selected?.kind),
    'Investigations run inquiry and output blocks without code delivery or closure steps.'
  );
}
function requireRepeatableInquiry(issue, block, input) {
  const currentScope = groupScope(issue);
  const scope = JSON.stringify(currentScope);
  const matchesScope = (entry) => JSON.stringify(entry.groupIssueIds ?? currentScope) === scope;
  const completed = block.attempts.some(
    (entry) => entry.status === 'completed' && entry.investigation?.mode !== 'discussion' && matchesScope(entry)
  );
  const { investigation = {} } = input;
  requireThat(
    [!completed, issue.reusable, investigation.mode === 'discussion'].some(Boolean),
    'Enable Reusable before starting another completed investigation.'
  );
}
function selectedInquiryBranch(flow) {
  return flow.investigation?.branch || flow.startingPoint?.ref;
}
export async function prepareInvestigationBlock(owner, issue, flow, block, input) {
  if (!isInvestigation(issue, flow) || !inquiryKinds.has(block.kind)) return;
  requireRepeatableInquiry(issue, block, input);
  if (input.action === 'continue') return;
  refreshInquirySettings(owner, issue, flow);
  flow.startingPoint = branchStartingPoint(await flowBranches(owner.service.root), selectedInquiryBranch(flow));
  invalidateBlocks(flow, new Set([block.id]));
}
function refreshInquirySettings(owner, issue, flow) {
  const settings = owner.issueSettings(issue, flow);
  requireValidExecutionSettings(settings);
  flow.executionSettings = { values: settings.values, sources: settings.sources, basis: settings.basis };
  flow.resolvedBranch = settings.values.branch;
}
function selectedSource(flow, issue, input, previous) {
  if (input.action === 'continue' && previous?.investigationSource)
    return structuredClone(previous.investigationSource);
  return successfulInvestigationSource(flow, issue.id, input.investigationRunId);
}
function publicationIdentity(input, previous, attempt) {
  return input.action === 'continue' && previous?.publicationId ? previous.publicationId : attempt.id;
}
function outputAttempt(flow, issue, block, input, attempt) {
  const previous = block.attempts.at(-1);
  const source = selectedSource(flow, issue, input, previous);
  return {
    investigationSource: source,
    publicationId: publicationIdentity(input, previous, attempt),
    outputAttemptId: attempt.id,
    supplementalFindings: block.kind === 'create-issues' ? successfulReportFindings(flow, source) : [],
  };
}
function inquiryAttempt(flow, block, input) {
  const { executionSettings = {}, investigation = {} } = flow;
  return (
    input.investigation || {
      mode: 'investigation',
      prompt: inquiryPrompt(flow, block),
      instructions: investigation.instructions,
      settings: executionSettings.values,
      startingPoint: structuredClone(flow.startingPoint),
    }
  );
}
function inquiryPrompt(flow, block) {
  const { investigation = {} } = flow;
  const goal = requestData(flow).fields?.goal;
  return [block.prompt, investigation.prompt || goal, investigation.instructions].filter(Boolean).join('\n\n');
}
function attachInquiryMetadata(flow, issue, block, input, attempt) {
  const inquiry = inquiryAttempt(flow, block, input);
  const scope = issue.issue_group && activeGroupRequest(issue, flow).wording;
  attempt.investigation = scope
    ? { ...inquiry, prompt: [inquiry.prompt, scope].filter(Boolean).join('\n\n') }
    : inquiry;
  attempt.details.push({
    key: 'investigationConfiguration',
    label: 'Investigation configuration',
    value: attempt.investigation,
    fixed: true,
  });
}

function attachOutputDetails(attempt) {
  attempt.supplementalSignature = supplementalFindingsSignature(attempt.supplementalFindings);
  const values = { source: attempt.investigationSource, supplementalFindings: attempt.supplementalFindings };
  for (const detail of attempt.details) if (Object.hasOwn(values, detail.key)) detail.value = values[detail.key];
  attempt.details.push({
    key: 'publicationId',
    label: 'Publication identity',
    value: attempt.publicationId,
    fixed: true,
  });
}
export function attachInvestigationAttempt(flow, issue, block, input, attempt) {
  if (!isInvestigation(issue, flow)) return;
  if (inquiryKinds.has(block.kind)) attachInquiryMetadata(flow, issue, block, input, attempt);
  if (!investigationOutputKinds.has(block.kind)) return;
  Object.assign(attempt, outputAttempt(flow, issue, block, input, attempt));
  attachOutputDetails(attempt);
}
export function configureInvestigationInquiry(flow, block, session, prompt) {
  if (!block.prompt || isManagedInvestigationPrompt(block)) {
    block.prompt = prompt;
    block.investigationPromptSha256 = digest(prompt);
  }
  session.flowOutputs = [
    block.kind === 'investigate',
    flow.investigationLayout === 2,
    flow.blocks.some(({ kind }) => investigationOutputKinds.has(kind)),
  ].some(Boolean);
}
function outputState(output, session, retry) {
  const [latest = {}] = output.attempts.slice(-1);
  const { investigationSource = {} } = latest;
  const same = investigationSource.attemptId === session.attemptId;
  return {
    skip: [retry, same, latest.status === 'completed', !latest.invalidatedAt].every(Boolean),
    action: retry && same ? 'continue' : 'start',
  };
}
async function executeOutput(owner, session, signal, output, state) {
  session.phase = output.label;
  owner.save(session);
  const current = owner.flows.read(owner.flows.selected(session.issueId));
  const accepted = await owner.flows.action({
    action: state.action,
    issueId: session.issueId,
    blockId: output.id,
    revision: current.revision,
    investigationOperation: session.id,
    investigationRunId: session.attemptId,
  });
  await owner.waitForBlock(session, signal);
  const saved = owner.flows.read(owner.flows.selected(session.issueId)).blocks.find(({ id }) => id === output.id);
  const attempt = saved.attempts.find(({ id }) => id === accepted.attemptId);
  requireThat(
    attempt?.status === 'completed',
    attempt?.summary || 'The output did not complete. Retry or run the other output independently.'
  );
}
export async function executeInvestigationOutputs(owner, session, signal, retry, kinds = investigationOutputKinds) {
  const flow = owner.flows.read(owner.flows.selected(session.issueId));
  for (const output of flow.blocks.filter(({ kind }) => kinds.has(kind))) {
    signal.throwIfAborted();
    const state = outputState(output, session, retry);
    if (!state.skip) await executeOutput(owner, session, signal, output, state);
  }
  delete session.phase;
}

export function usesInvestigationOutputs(owner, session) {
  const flow = owner.flows.read(owner.flows.selected(session.issueId));
  return flow.blocks.some(({ kind }) => kind === 'investigate') || session.flowOutputs === true;
}
export function retryOutputKinds(session) {
  return session.flowOutputs === true ? investigationOutputKinds : new Set(['create-issues']);
}

function completedReport(block) {
  if (block.kind !== 'generate-report') return false;
  return latestCurrentAttempt(block)?.status === 'completed';
}
function consumedFindings(attempt) {
  return attempt.supplementalSignature ?? supplementalFindingsSignature(attempt.supplementalFindings ?? []);
}
function changedSupplementalFindings(flow, block) {
  const attempt = latestCurrentAttempt(block);
  if (!attempt) return false;
  if (attempt.status !== 'completed') return false;
  if (!attempt.investigationSource) return false;
  return (
    consumedFindings(attempt) !==
    supplementalFindingsSignature(successfulReportFindings(flow, attempt.investigationSource))
  );
}
export function reconcileInvestigationFindings(flow, producer) {
  if (!completedReport(producer)) return flow;
  for (const block of flow.blocks.filter(({ kind }) => kind === 'create-issues')) {
    if (changedSupplementalFindings(flow, block)) invalidateBlocks(flow, new Set([block.id]), false);
  }
  return flow;
}
