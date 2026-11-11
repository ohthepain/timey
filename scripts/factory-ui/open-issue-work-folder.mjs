import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat } from './common.mjs';
import { issueGit } from './issue-git.mjs';

export function openIssueWorkFolder(service, issueId, open = execFileSync) {
  const snapshot = service.snapshot();
  const issue = snapshot.issues.find((entry) => entry.id === issueId);
  const checkout = issue && issueGit(snapshot, issue)?.checkout;
  requireThat(checkout, 'This issue has no available work folder.');

  const folder = realpathSync(resolve(checkout));
  requireThat(existsSync(folder) && statSync(folder).isDirectory(), 'The issue work folder is unavailable.');
  open('open', [folder], { stdio: 'ignore' });
  return { opened: true };
}
