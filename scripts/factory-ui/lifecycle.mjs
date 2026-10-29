import { defaultRoute, explicitRoute } from './delivery-mode.mjs';
import { outcomeSource } from './stage-source.mjs';
import { skipAllowed } from './skip-policy.mjs';
import { requireThat } from './common.mjs';

export const routeSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      issueId: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            state: { type: 'string' },
            decision: { type: 'string', enum: ['take', 'skip', 'undecided'] },
            reason: { type: 'string' },
          },
          required: ['state', 'decision', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['issueId', 'steps'],
    additionalProperties: false,
  },
};
export function validateRoutes(queue, routes, focus = null) {
  requireThat(Array.isArray(routes), 'The proposed routes must be a list.');
  const seen = new Set();
  const normalized = [];
  for (const proposal of routes) {
    const route = normalizeRoute(queue, proposal);
    requireThat(!seen.has(route.issueId), 'The review proposed more than one route for an issue.');
    seen.add(route.issueId);
    validateRoute(queue, route, focus);
    normalized.push(route);
  }
  return normalized;
}
// Model responses may use the configured display label instead of its state ID.
// Resolve exact, unique labels only; validation still owns decisions and policy.
function normalizeRoute(queue, route) {
  if (!Array.isArray(route.steps)) return route;
  return { ...route, steps: route.steps.map((step) => ({ ...step, state: routeState(queue, step.state) })) };
}
function routeState(queue, value) {
  if (knownState(queue, value)) return value;
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const matches = queue.lifecycle.filter((stage) => stage.name?.toLowerCase() === name);
  requireThat(
    matches.length === 1,
    `Unknown or ambiguous route stage ${JSON.stringify(value)}. Use a configured state: ${queue.lifecycle.map((stage) => stage.state).join(', ')}, @integration.`
  );
  return matches[0].state;
}
function validateRoute(queue, route, focus) {
  const issue = queue.issues.find((i) => i.id === route.issueId);
  requireThat(issue, 'The route names an unknown issue.');
  requireThat(!focus || route.issueId === focus, 'A route belongs to an issue outside this review.');
  requireThat(Array.isArray(route.steps), 'The route needs a list of steps.');
  validateSteps(queue, issue, route.steps);
}
function validateSteps(queue, issue, steps) {
  const seen = new Set();
  for (const step of steps) {
    requireThat(!seen.has(step.state), 'The route repeats a step.');
    seen.add(step.state);
    validateStep(queue, issue, step);
  }
}
function validateStep(queue, issue, step) {
  requireThat(knownState(queue, step.state), 'The route names an unknown stage.');
  requireThat(['take', 'skip', 'undecided'].includes(step.decision), 'Each planned step needs a decision.');
  requireThat(nonempty(step.reason), 'Each planned step needs a plain-language reason.');
  if (step.decision === 'skip') validatePlannedSkip(queue, issue, step.state);
}
function knownState(queue, state) {
  return state === '@integration' || queue.lifecycle.some((s) => s.state === state);
}
function nonempty(value) {
  return typeof value === 'string' && Boolean(value.trim());
}
function validatePlannedSkip(queue, issue, state) {
  const stage = queue.lifecycle.find((s) => s.state === state);
  // Repeated capture history is not a new request to bypass today's policy.
  if (historicalSkip(queue, issue, state)) return;
  requireThat(
    skipAllowed(queue, issue, state),
    `${stage?.name || state} is required by project policy and cannot be planned as a skip. If its work already exists, record its completion instead.`
  );
}
function historicalSkip(queue, issue, state) {
  if (state === issue.state || stageOutcome(issue, state)?.outcome !== 'skipped') return false;
  const links = new Map(queue.lifecycle.map((stage) => [stage.state, stage.next]));
  const seen = new Set([state]);
  let next = links.get(state);
  while (next && !seen.has(next)) {
    if (next === issue.state) return true;
    seen.add(next);
    next = links.get(next);
  }
  return false;
}
export function savedRoute(issue, runs, queue = null) {
  return queue ? defaultRoute(queue, issue, runs) : explicitRoute(issue, runs);
}
export function stageOutcome(issue, state) {
  const history = Array.isArray(issue.lifecycle_history) ? issue.lifecycle_history : [];
  const events = history.slice(history.findLastIndex((e) => e.outcome === 'reopened') + 1);
  return events.findLast((e) => e.state === state && validOutcome(e)) || null;
}
function validOutcome(event) {
  return ['completed', 'skipped'].includes(event.outcome) && nonempty(event.reason) && hasRecordEvidence(event);
}
function hasRecordEvidence(event) {
  return Array.isArray(event.evidence) && event.evidence.length > 0 && nonempty(event.at);
}
export function recordStage(doc, issue, target, result, run, evidence) {
  if (!target) return;
  const events = historyFrom(doc);
  requireThat(Array.isArray(events), 'The stage history is invalid. Preserve and reconcile it before advancing.');
  if (result.stage_records) return recordMultiple(doc, events, issue, result, run, evidence, target);
  recordSingle(doc, events, issue, target, result, run, evidence);
}
function recordSingle(doc, events, issue, target, result, run, evidence) {
  events.push({
    state: issue.state,
    outcome: 'completed',
    next: target,
    at: new Date().toISOString(),
    reason: result.summary,
    revision: run.base,
    chat: run.threadId,
    authorization: run.authorization,
    evidence,
  });
  for (const step of result.skipped_steps || [])
    events.push({
      state: step.state,
      outcome: 'skipped',
      next: target,
      at: new Date().toISOString(),
      reason: step.reason,
      source: outcomeSource(issue, run, step.state),
      revision: run.base,
      chat: run.threadId,
      authorization: run.authorization,
      evidence,
    });
  doc.set('lifecycle_history', doc.createNode(events, { aliasDuplicateObjects: false }));
}

function historyFrom(doc) {
  return doc.get('lifecycle_history')?.toJSON() || [];
}

function recordMultiple(doc, events, issue, result, run, evidence, target) {
  for (const step of result.stage_records)
    events.push({
      ...step,
      source: outcomeSource(issue, run, step.state),
      next: target,
      at: new Date().toISOString(),
      revision: run.base,
      chat: run.threadId,
      authorization: run.authorization,
      evidence,
    });
  doc.set('lifecycle_history', doc.createNode(events, { aliasDuplicateObjects: false }));
}
