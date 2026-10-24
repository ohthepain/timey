import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest, requireThat } from './common.mjs';
import { selectPlan, implementationPlans } from './plan-outline.mjs';
import { reviewEvidence } from './review-result.mjs';

export function checklistBasis(queue, issue, plan) {
  return digest(
    JSON.stringify({
      head: queue.head,
      source: queue.snapshot.worktree,
      report: issue.content,
      lifecycle: queue.lifecycle,
      plan: plan.sha256,
      actions: queue.actions.filter((a) => a.issues.includes(issue.id)),
    })
  );
}
export function checklistView(queue, issue, runs) {
  const paths = implementationPlans(issue, queue.actions);
  if (!paths.length) return null;
  try {
    return checklistDetails(queue, issue, runs, paths);
  } catch (error) {
    return { paths, path: paths[0], fresh: false, canCheck: false, problem: error.message };
  }
}
function checklistDetails(queue, issue, runs, paths) {
  const record = issue.plan_verification;
  const run = runs.findLast((r) => r.kind === 'plan-check' && r.issueId === issue.id);
  const plan = selectPlan(queue, issue, record?.path || paths[0]);
  const fresh = checklistFresh(queue, issue, plan, record, runs);
  return {
    paths,
    path: plan.path,
    record,
    fresh,
    ...reviewStatus(run, fresh),
    summary: fresh ? record.summary : 'Check the plan against the existing work and saved test results.',
  };
}
function reviewStatus(run, fresh) {
  const running = !!run?.connected;
  return { running, canCheck: !running && !fresh, problem: reviewProblem(run) };
}
function reviewProblem(run) {
  return run?.status === 'blocked' ? run.summary : null;
}
function checklistFresh(queue, issue, plan, record, runs) {
  if (!matchingPlan(record, plan)) return false;
  const saved = runs.find((r) => r.id === record.run_id && r.status === 'completed');
  if (saved?.afterBasis !== checklistBasis(queue, issue, plan)) return false;
  return record.evidence
    .filter((e) => e.path !== join(queue.root, '.issues', issue.id + '.md'))
    .every(evidenceUnchanged);
}
function matchingPlan(record, plan) {
  return record && record.plan_sha256 === plan.sha256;
}
function evidenceUnchanged(entry) {
  return existsSync(entry.path) && digest(readFileSync(entry.path)) === entry.sha256;
}
export function requireImplementationPasses(service, queue, issue, includeHuman = false) {
  if (!issue.plan_verification) return;
  const view = checklistView(queue, issue, service.store.list(service.codex.requests));
  requireThat(view.fresh, 'Check the implementation steps again before continuing.');
  requireThat(
    issue.plan_verification.steps.every((s) => s.criteria.every((c) => criterionSatisfied(issue, c, includeHuman))),
    'Finish the outstanding implementation checks before continuing.'
  );
}
function criterionSatisfied(issue, criterion, includeHuman) {
  if (['passed', 'skipped'].includes(criterion.status)) return true;
  if (includeHuman) return false;
  return issue.human_checks?.some((c) => c.id === criterion.human_check_id && c.blocks === 'closure');
}

export function checkedPlanResult(queue, issue, plan, result) {
  requireThat(nonempty(result.summary), 'The checklist needs a short conclusion.');
  requireThat(boundedItems(result.steps, 101), 'The review must return the plan’s work items.');
  const ids = result.steps.map((step) => step.id);
  requireThat(new Set(ids).size === ids.length, 'A plan step was repeated.');
  if (plan.steps.length)
    requireThat(
      JSON.stringify(ids) === JSON.stringify(plan.steps.map((s) => s.id)),
      'Include every plan step once, in plan order.'
    );
  for (const step of result.steps) validateStep(issue, plan, step, queue.head);
  const files = [...new Set(result.steps.flatMap((s) => s.criteria.flatMap((c) => c.evidence)))];
  const evidence = checklistEvidence(queue, result, files);
  return {
    ...normalizeEvidence(result, files, evidence),
    path: plan.path,
    plan_sha256: plan.sha256,
    revision: queue.head,
    evidence,
  };
}
function normalizeEvidence(result, files, evidence) {
  const normalized = structuredClone(result);
  const paths = new Map(files.map((path, index) => [path, evidence[index].path]));
  for (const criterion of normalized.steps.flatMap((s) => s.criteria))
    criterion.evidence = criterion.evidence.map((path) => paths.get(path));
  return normalized;
}

function checklistEvidence(queue, result, files) {
  return files.length
    ? reviewEvidence(
        queue.root,
        { cwd: queue.root },
        {
          outcome: 'completed',
          summary: result.summary,
          notes: 'Implementation checklist review.',
          evidence: files,
          remaining: [],
          next_state: null,
        }
      )
    : [];
}
export function readChecklistEvidence(queue, id, path) {
  const issue = queue.issues.find((i) => i.id === id);
  const canonical = realpathSync(path);
  const entry = issue?.plan_verification?.evidence.find((e) => e.path === canonical);
  requireThat(entry, 'Choose a supporting file from this issue’s checklist.');
  requireThat(
    statSync(path).isFile() && statSync(path).size < 1048576,
    'This supporting file is too large for the document viewer.'
  );
  const content = readFileSync(path);
  requireThat(content.length < 1048576, 'This supporting file is too large for the document viewer.');
  requireThat(
    digest(content) === entry.sha256,
    'This file changed since review. Check the implementation steps again.'
  );
  return { path, content: content.toString('utf8') };
}
function validateStep(issue, plan, step, head) {
  requireThat(nonempty(step.name), 'Each step needs a short name.');
  const source = stepSource(plan, step);
  requireThat(boundedItems(step.criteria, 51), 'Each step needs acceptance criteria.');
  for (const criterion of step.criteria) validateCriterion(issue, source, criterion, head);
}
function stepSource(plan, step) {
  if (!plan.steps.length) {
    const line = Number(step.id?.match(/^line-(\d+)$/)?.[1]);
    requireThat(line > 0 && line <= plan.content.split('\n').length, 'Link each step to its source line.');
    return plan.content;
  }
  const source = plan.steps.find((s) => s.id === step.id);
  requireThat(source.version === step.version, 'Preserve the plan’s version groups.');
  return source.source;
}
function validateCriterion(issue, source, criterion, head) {
  requireThat(
    ['name', 'source', 'explanation'].every((key) => nonempty(criterion[key])),
    'Each criterion needs its requirement and result.'
  );
  requireThat(source.includes(criterion.source), 'A criterion must retain an exact original requirement.');
  requireThat(
    ['passed', 'failed', 'todo', 'not-checked', 'in-progress', 'skipped'].includes(criterion.status),
    'Unknown checklist status.'
  );
  requireThat(Array.isArray(criterion.evidence), 'Evidence must be a list of files.');
  if (['passed', 'failed', 'skipped'].includes(criterion.status))
    requireThat(criterion.evidence.length > 0, 'A pass, failure or skip needs inspected supporting files.');
  validateNextAction(criterion);
  if (criterion.human_check_id) validateHumanCriterion(issue, criterion, head);
}
function validateHumanCriterion(issue, criterion, head) {
  const check = issue.human_checks?.find((c) => c.id === criterion.human_check_id);
  requireThat(check, 'An approval requirement must refer to an existing human check.');
  if (criterion.status === 'passed')
    requireThat(
      check.status === 'passed' && check.result && check.revision === head,
      'Automated review cannot approve a human check.'
    );
}

function validateNextAction(criterion) {
  if (!['passed', 'skipped'].includes(criterion.status))
    requireThat(nonempty(criterion.next_action), 'Explain exactly what is needed to finish each unchecked item.');
}
function nonempty(value) {
  return typeof value === 'string' && value.trim();
}
function boundedItems(items, limit) {
  return Array.isArray(items) && items.length > 0 && items.length < limit;
}
