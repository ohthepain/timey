import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';

export function factoryGitFixture(t, prefix) {
  const fixture = gitFixture(t, prefix);
  initializeFolderSettings(fixture.root);
  fixture.git('add', 'folder.md', 'user/Inbox/folder.md');
  return fixture;
}

// Test repositories never inherit the caller's live hooks or identity.
export function gitFixture(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
      .toString()
      .trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.hooksPath', '/dev/null');
  return { root, git };
}
