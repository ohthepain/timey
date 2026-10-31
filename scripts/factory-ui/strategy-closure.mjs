import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { digest, git, requireThat, readJson } from './common.mjs';
import { validateSummary } from './checks.mjs';

// Accept retained strategy evidence, without advancing legacy roles or running checks.
export function strategyClosureResult(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  if (!record?.work) return null;
  const work = record.work;
  const run = service.store.runs.find((entry) => entry.id === work.runId && entry.issueId === issue.id);
  requireThat(run?.status === 'completed', 'This strategy has no completed, verified result to accept.');
  const checked = run.result?.checked;
  requireThat(checked?.summaries?.length, 'The strategy result is missing its saved verification summaries.');
  requireThat(
    checked.head === work.readiness?.head && checked.tree === git(work.checkout, 'rev-parse', checked.head + '^{tree}'),
    'The saved strategy checks do not match the recorded candidate.'
  );
  const checkpoints = new Set();
  const paths = [join(service.store.directory, run.id, 'readiness.json')];
  const saved = readJson(paths[0]);
  requireThat(
    JSON.stringify(saved.checked) === JSON.stringify(checked),
    'The saved strategy verification evidence changed.'
  );
  for (const path of checked.summaries) {
    const summary = readJson(path);
    try {
      validateSummary(summary, work.base, checked.tree);
    } catch (error) {
      const failed = (summary.checks || []).filter((check) => !check.passed).map((check) => check.name);
      throw Error(
        `${error.message}${failed.length ? ' Failed checks: ' + failed.join(', ') + '.' : ''} Saved evidence: ${path}`
      );
    }
    checkpoints.add(summary.checkpoint);
    paths.push(path, ...summary.checks.map((check) => check.log));
    for (const check of summary.checks) paths.push(...(check.artifacts || []).map((file) => file.path));
  }
  requireThat(
    checkpoints.has('verification') && checkpoints.has('step'),
    'Required verification or step audit evidence is missing.'
  );
  return {
    revision: checked.head,
    checkout: work.checkout,
    evidence: [...new Set(paths)].map((path) => ({ path, sha256: digest(readFileSync(path)) })),
  };
}
