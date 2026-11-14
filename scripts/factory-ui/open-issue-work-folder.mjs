import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat } from './common.mjs';
import { issueGit } from './issue-git.mjs';

export function openIssueWorkFolder(service, issueId, open = execFileSync) {
  const snapshot = service.snapshot();
  const issue = snapshot.issues.find((entry) => entry.id === issueId);
  const checkout = issue && issueGit(snapshot, issue)?.checkout;
  return openWorkFolder(checkout, open);
}

export function openWorkFolder(checkout, open = execFileSync) {
  requireThat(checkout, 'This issue has no available work folder.');
  requireThat(existsSync(checkout), 'The issue work folder is unavailable.');
  const folder = realpathSync(resolve(checkout));
  requireThat(existsSync(folder) && statSync(folder).isDirectory(), 'The issue work folder is unavailable.');
  open('open', [folder], { stdio: 'ignore' });
  return { opened: true };
}
