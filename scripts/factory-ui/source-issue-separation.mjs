import { execFileSync } from 'node:child_process';
import { requireThat } from './common.mjs';
import { queueMetadataPath } from './shared-issue-config.mjs';

export function assertSourceIssueSeparation(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const configPath = git('ls-files', '--', 'factory.config.json');
  if (!configPath) return;
  const config = JSON.parse(git('show', ':factory.config.json'));
  if (config.sharedIssueQueue !== true) return;
  const files = git('ls-files', '-z', '--', '.issues/').split('\0').filter(queueMetadataPath);
  requireThat(
    files.length === 0,
    'Shared reports, statuses, numbers and claims belong on the issue queue branch. ' +
      'Use scripts/detach-issue-reports.mjs with a verified queue ref to remove cached reports from source tracking.'
  );
}
