import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIssueNumbers } from './factory-ui/issue-numbers.mjs';

// Selection narrows the assignment; retain the whole inspection for dependencies and existing work.
export function decisionView(inspection, selectors, project) {
  const issueNumbers = ensureIssueNumbers(
    project,
    inspection.reports.map((report) => report.metadata.id)
  );
  const ids = selectors.length
    ? selectors.map((selector) => resolveIssue(inspection.reports, selector, issueNumbers))
    : inspection.reports.map((report) => report.metadata.id);
  return {
    ...inspection,
    mode: 'decide',
    focus_issue_ids: [...new Set(ids)],
    instruction:
      'Evaluate this focus and offer human input, a saved launch group, or both. Launch requires a separate selection.',
  };
}

function resolveIssue(reports, selector, issueNumbers) {
  const matches = matchingReports(reports, selector),
    issueId = numberedReportId(reports, selector, issueNumbers);
  if (matches.length === 1) return matches[0].metadata.id;
  if (issueId) return issueId;
  throw selectionError(selector, matches);
}

function matchingReports(reports, selector) {
  const exact = reports.filter((report) => report.metadata.id === selector);
  return exact.length ? exact : reports.filter((report) => report.metadata.id.startsWith(selector));
}

function numberedReportId(reports, selector, issueNumbers) {
  const number = /^#?(\d+)$/.exec(selector)?.[1];
  return reports.find((report) => issueNumbers[report.metadata.id] === Number(number))?.metadata.id;
}

function selectionError(selector, matches) {
  if (!matches.length) return Error(`Unknown issue: ${selector}. Use factory issues to list reports.`);
  return Error(`Ambiguous issue: ${selector}. Matches: ${matches.map((report) => report.metadata.id).join(', ')}`);
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
