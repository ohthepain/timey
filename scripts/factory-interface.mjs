import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Selection narrows the assignment; retain the whole inspection for dependencies and existing work.
export function decisionView(inspection, selectors) {
  const ids = selectors.length
    ? selectors.map((selector) => resolveIssue(inspection.reports, selector))
    : inspection.reports.map((report) => report.metadata.id);
  return {
    ...inspection,
    mode: 'decide',
    focus_issue_ids: [...new Set(ids)],
    instruction:
      'Evaluate this focus and offer human input, a saved launch group, or both. Launch requires a separate selection.',
  };
}

function resolveIssue(reports, selector) {
  const exact = reports.filter((report) => report.metadata.id === selector);
  const matches = exact.length ? exact : reports.filter((report) => report.metadata.id.startsWith(selector));
  if (matches.length === 1) return matches[0].metadata.id;
  if (!matches.length) throw Error(`Unknown issue: ${selector}. Use factory issues to list reports.`);
  throw Error(`Ambiguous issue: ${selector}. Matches: ${matches.map((report) => report.metadata.id).join(', ')}`);
}

export function listIssues(project, args) {
  const root = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const helper = join(root, '.agents/skills/issues/scripts/list-issues.mjs');
  if (!existsSync(helper))
    throw Error('Installed issues listing helper missing. Install the local issues skill in this project.');
  if (args.includes('--project')) throw Error('factory issues uses the current project; omit --project.');
  return JSON.parse(
    execFileSync(process.execPath, [helper, '--project', root, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  );
}
