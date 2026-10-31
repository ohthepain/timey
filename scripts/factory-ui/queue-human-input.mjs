import { inspectHumanInput } from './guard.mjs';
import { recordedResult } from './recorded-result.mjs';
import { digest } from './common.mjs';

// This is presentation only. Dispatch still uses the independent human guard.
export function queueHumanInput(queue, issue) {
  const facts = readinessFacts(queue, issue);
  const { result } = inspectHumanInput(queue.root, { issues: [issue.id] }, 'view', queue.head, {}, facts);
  return result.issues.find((entry) => entry.id === issue.id) || { requests: [], diagnostics: result.diagnostics };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function revision(value) {
  return 'sha256:' + digest(canonical(value));
}
function readinessFacts(queue, issue) {
  return [...deliveryFacts(issue), ...acceptanceFacts(queue, issue)];
}
function deliveryFacts(issue) {
  const delivery = issue.issueDelivery;
  const contributions = delivery?.contributions || [];
  const candidate = contributions.some(
    (entry) => entry.candidate === delivery.candidate && entry.tree === delivery.tree
  );
  const refs = contributions.map((entry) => entry.receipt?.path).filter(Boolean);
  if (!candidate || !refs.length) return [];
  const sources = [
    ...(issue.human_input?.requests || []).map((source) => ['human_input:' + source.id, source]),
    ...(issue.human_checks || []).map((source) => ['human_checks:' + source.id, source]),
  ];
  return sources.map(([source_key, source]) => ({
    source_key,
    source_revision: revision(source),
    evidence_refs: refs,
    'work-ready': true,
    'candidate-ready': true,
    'evidence-ready': !!delivery.readiness,
  }));
}
function acceptanceFacts(queue, issue) {
  const final = queue.lifecycle.some((stage) => stage.state === issue.state && stage.role === 'ready-to-close');
  if (!final) return [];
  const delivery = issue.issueDelivery;
  const result = delivery ? null : recordedResult(queue, issue);
  if (delivery ? delivery.state !== 'verified' : !result?.revision) return [];
  const source = { revision: delivery?.candidate || result.revision, tree: delivery?.tree || null };
  return [
    {
      source_key: 'acceptance:issue',
      source_revision: revision(source),
      authority: 'acceptance',
      status: 'pending',
      evidence_refs: [delivery?.integration?.path || queue.root + '/.issues/' + issue.id + '.md'],
      blocks: [{ operation: 'accept', scope_ids: ['*'] }],
    },
  ];
}
