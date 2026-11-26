import { readFileSync, existsSync } from 'node:fs';
import { digest, requireThat } from './common.mjs';
import { inquiryKinds, investigationOutputKinds, investigationAttempts } from './investigation-flow.mjs';
import { isInvestigation } from './investigation-records.mjs';
import { projectIssueRecords } from './project-home-stats.mjs';

export function investigationConfiguration(owner, issue, flow) {
  const previous = [...owner.sessions.values()].findLast((session) => session.issueId === issue.id);
  const request = flow.blocks.find(({ kind }) => kind === 'request')?.data;
  return {
    focus: previous?.focus || 'Custom',
    prompt: request?.fields?.goal || request?.wording || issue.title,
    instructions: '',
    branch: previous?.branch || flow.startingPoint?.ref,
    ...flow.investigation,
  };
}

function retainedOutput(attempt) {
  const file = attempt.artifacts?.files?.response;
  if (!file) return attempt.output || attempt.summary || '';
  if (!existsSync(file.path)) return 'The retained result file is unavailable.';
  const bytes = readFileSync(file.path);
  return file.sha256 && digest(bytes) === file.sha256
    ? bytes.toString('utf8')
    : 'The retained result changed and cannot be verified.';
}

export function investigationCreatedIssues(reports, { issueId, attemptId }) {
  return reports
    .filter((entry) => entry.source_issue === issueId && entry.source_attempt === attemptId)
    .map(({ id, title, state, location }) => ({ id, title, state, location, relation: 'created' }));
}

function runView(attempt, block, sessions, reports, issueId) {
  const session = sessions.find((entry) => entry.attemptId === attempt.id);
  const issues = investigationCreatedIssues(reports, { issueId, attemptId: attempt.id });
  const tracked = (session?.trackedIssues || []).flatMap((id) => {
    const entry = reports.find((entry) => entry.id === id);
    return entry ? [{ id, title: entry.title, state: entry.state, location: entry.location, relation: 'tracked' }] : [];
  });
  const config = attempt.investigation || session;
  return {
    id: attempt.id,
    blockId: block.id,
    sessionId: session?.id,
    mode: config?.mode || 'investigation',
    status: session?.status === 'failed' ? 'failed' : attempt.status,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    summary: attempt.summary,
    output: retainedOutput(attempt),
    revision: config?.startingPoint?.commit || attempt.result?.head,
    settings: config?.settings,
    prompt: config?.prompt || attempt.systemPrompt,
    issues: [...issues, ...tracked],
    evidence: attempt.evidence || [],
    error: session?.error,
  };
}

export function investigationIssueView(owner, issueId) {
  const issue = owner.flows.selected(issueId);
  const flow = owner.flows.read(issue);
  requireThat(isInvestigation(issue, flow), 'Choose an investigation issue.');
  const sessions = [...owner.sessions.values()].filter((entry) => entry.issueId === issue.id);
  const reports = projectIssueRecords(owner.service.root);
  const runs = investigationAttempts(flow, inquiryKinds)
    .map(({ block, attempt }) => ({
      ...runView(attempt, block, sessions, reports, issue.id),
      outputAttempts: investigationAttempts(flow, investigationOutputKinds)
        .filter((entry) => entry.attempt.investigationSource?.attemptId === attempt.id)
        .map((entry) => ({ ...entry.attempt, blockId: entry.block.id, kind: entry.block.kind })),
    }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return {
    issueId: issue.id,
    title: issue.title,
    revision: flow.revision,
    reusable: issue.reusable === true,
    archived: issue.location === 'archive',
    needsApproval: issue.state === 'needs-approval',
    configuration: investigationConfiguration(owner, issue, flow),
    runs: runs.filter(({ mode }) => mode !== 'discussion'),
    discussions: runs.filter(({ mode }) => mode === 'discussion'),
    active: sessions.findLast((session) => owner.active.has(session.id)) || null,
  };
}
