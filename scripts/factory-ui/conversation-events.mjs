import { join } from 'node:path';
import { digest } from './common.mjs';

export function issueHistoryEvents(service, queue, issue) {
  const report = join(service.root, '.issues', issue.id + '.md');
  const record = service.lifecycleRuns?.[issue.id];
  const source = { evidence: [{ path: report, label: 'Issue report' }] };
  return [
    originalRequest(issue, source),
    ...stageEvents(queue, issue, source),
    ...grillingEvents(issue, source),
    ...verificationEvents(service, issue, record),
    ...deliveryEvents(service, issue, record),
    ...closureEvents(issue, source),
  ];
}

function originalRequest(issue, source) {
  const content = String(issue.content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const original = /^## Original request\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(content);
  const attribution = original
    ? { actor: 'human', role: 'Original request', body: original[1].trim() }
    : { actor: 'factory', role: 'Issue report', body: content.trim() };
  return {
    id: 'capture:' + issue.id,
    ...attribution,
    kind: 'original-request',
    at: issue.created || '',
    source,
  };
}

function factoryEvent(kind, identity, at, body, source, status) {
  return {
    id: kind + ':' + digest(JSON.stringify(identity)),
    actor: 'factory',
    role: 'Factory',
    kind,
    at,
    body,
    source,
    status,
  };
}

function stageEvents(queue, issue, source) {
  return (issue.lifecycle_history || []).map((entry) => {
    const stage = queue.lifecycle.find((item) => item.state === entry.state);
    return factoryEvent(
      'stage-outcome',
      [issue.id, entry],
      entry.at,
      `${stage?.name || entry.state}: ${entry.outcome}. ${entry.reason}`,
      {
        ...source,
        revision: entry.revision,
        decisionSource: entry.source,
        evidence: [...source.evidence, ...evidencePaths(entry.evidence)],
      },
      entry.outcome
    );
  });
}

function grillingEvents(issue, source) {
  return (issue.stage_grilling || [])
    .filter((entry) => entry.confirmed === true)
    .map((entry) =>
      factoryEvent(
        'reviewed-decision',
        [issue.id, entry.state, entry.at, entry.revision],
        entry.at,
        `Reviewed ${entry.name} discussion. ${entry.summary}\nThese recorded decisions do not establish implementation, passing checks, merge or acceptance.`,
        { ...source, revision: entry.revision },
        'recorded'
      )
    );
}

function evidencePaths(values = []) {
  return values
    .map((value) => (typeof value === 'string' ? { path: value, label: 'Evidence' } : value))
    .filter((value) => typeof value?.path === 'string');
}

function verificationEvents(service, issue, record) {
  const work = record?.work;
  const results = service.store.runs
    .filter((run) => run.issueId === issue.id && run.result?.checked)
    .map((run) => ({ checked: run.result.checked, at: run.finished || run.created, runId: run.id }));
  if (work?.verification) results.push({ ...work.verification, runId: work.runId });
  const events = results.map(({ checked, at, runId }) =>
    factoryEvent(
      'factory-verification',
      [issue.id, checked.head, checked.summaries],
      at,
      `Factory recorded passing verification for commit ${checked.head}. This records that candidate's check outcome, not acceptance or proof for later edits.`,
      { runId, revision: checked.head, evidence: evidencePaths(checked.summaries) },
      'passed'
    )
  );
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function deliveryEvents(service, issue, record) {
  const work = record?.work;
  if (!work?.merge) return [];
  const merge = work.merge;
  const source = {
    runId: work.runId,
    revision: merge.revision,
    url: merge.url,
    evidence: [{ path: join(service.root, '.issues/factory-ui/lifecycle.json'), label: 'Saved delivery outcome' }],
  };
  return [mergeEvent(issue, work, source), localTargetEvent(issue, work, source)];
}

function mergeEvent(issue, work, source) {
  const merge = work.merge;
  return factoryEvent(
    'github-merge',
    [issue.id, merge.revision],
    work.mergedAt || merge.at || '',
    `GitHub merge confirmed at ${merge.revision}. ${merge.url || ''}\nLocal target update and issue acceptance are separate.`,
    source,
    'merged'
  );
}

function targetName(work) {
  return work.config?.target || work.target || 'target';
}

function localTargetOutcome(work) {
  const target = targetName(work);
  const update = work.localDevUpdate;
  if (!update) return { status: 'pending', body: `Local ${target} update has no confirmed outcome yet.` };
  switch (update.status) {
    case 'updated':
      return { ...update, body: `Local ${target} updated to ${update.revision}.` };
    case 'not-updated':
      return { ...update, body: `Local ${target} was not updated. ${update.reason}` };
    default:
      return { ...update, body: `Local ${target} update outcome needs reconciliation.` };
  }
}

function localTargetEvent(issue, work, source) {
  const outcome = localTargetOutcome(work);
  return factoryEvent(
    'local-target-update',
    [issue.id, work.merge.revision],
    work.localDevUpdatedAt || '',
    outcome.body,
    { ...source, localRevision: outcome.revision },
    outcome.status
  );
}

function closureEvents(issue, source) {
  const closure = issue.closure;
  if (!closure) return [];
  return [
    factoryEvent(
      'issue-closure',
      [issue.id, closure.at, closure.reason],
      closure.at,
      `Issue closed as ${closure.label}. ${closure.details || ''}`,
      source,
      closure.reason
    ),
  ];
}
