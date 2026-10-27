import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessAudit } from '../audit-result.mjs';
import { git, readJson, requireThat, runLogged } from './common.mjs';

export async function checkCandidate(root, base, folder) {
  requireThat(
    existsSync(join(root, 'node_modules')),
    'Matching dependencies are missing from the worker checkout. Install them there before continuing.'
  );
  mkdirSync(folder, { recursive: true });
  const evidence = join(root, '.issues/evidence'),
    before = new Set(existsSync(evidence) ? readdirSync(evidence) : []);
  await runLogged(root, 'pnpm', ['run', 'verify', '--', '--base', base], join(folder, 'verify.log'));
  await runLogged(root, 'pnpm', ['run', 'audit:step', '--', '--base', base], join(folder, 'audit-step.log'));
  const summaries = readdirSync(evidence)
    .filter((n) => n.endsWith('-summary.json') && !before.has(n))
    .map((n) => ({ path: join(evidence, n), value: readJson(join(evidence, n)) }));
  requireThat(
    ['verification', 'step'].every((kind) => summaries.some((s) => s.value.checkpoint === kind)),
    'Verification did not produce fresh evidence.'
  );
  const head = git(root, 'rev-parse', 'HEAD'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    !git(root, 'status', '--porcelain', '--untracked-files=all'),
    'The checked checkout has uncommitted source changes.'
  );
  for (const { value } of summaries) validateSummary(value, base, tree);
  return { head, tree, summaries: summaries.map((s) => s.path) };
}
export function validateSummary(summary, base, tree) {
  requireThat(
    matchesSummary(summary, base, tree),
    'Evidence does not match the exact candidate tree and recorded base.'
  );
  if (summary.checkpoint === 'verification') validateRequiredChecks(summary);
  for (const check of summary.checks) validateCommand(check);
}
function validateRequiredChecks(summary) {
  const required = ['fallow', 'factory', 'typecheck', 'tests', 'build'];
  if (summary.changed_files.length) required.push('format-changed');
  requireThat(
    required.every((n) => summary.checks.some((c) => c.name === n && c.passed)),
    'A required check is missing or failed.'
  );
}
function validateCommand(check) {
  requireThat(check.passed && check.exit === 0, 'A required command failed.');
  if (check.name !== 'fallow') return;
  const [stdout, ...stderr] = readFileSync(check.log, 'utf8').split(/\r?\n/);
  const result = assessAudit({ status: check.exit, stdout, stderr: stderr.join('\n') });
  requireThat(result.passed, 'The raw Fallow evidence does not pass the strict gate.');
}

function matchesSummary(summary, base, tree) {
  return summary.base === base && summary.snapshot_tree === tree && summary.passed;
}
