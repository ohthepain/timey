import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openIssueWorkFolder } from './factory-ui/open-issue-work-folder.mjs';

test('opens the selected issue checkout in Finder', () => {
  const root = mkdtempSync(join(tmpdir(), 'timey-issue-folder-'));
  const checkout = join(root, 'checkout');
  try {
    execFileSync('git', ['init', '-q', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', checkout, 'commit', '--allow-empty', '-qm', 'fixture']);
    const calls = [];
    const service = {
      snapshot: () => ({
        issues: [{ id: 'issue-1', strategy: { checkout } }],
        actions: [],
        runs: [],
      }),
    };

    assert.deepEqual(
      openIssueWorkFolder(service, 'issue-1', (...args) => calls.push(args)),
      { opened: true }
    );
    assert.equal(calls[0][0], 'open');
    assert.equal(calls[0][1][0], realpathSync(checkout));
    assert.throws(() => openIssueWorkFolder(service, 'missing', () => {}), /no available work folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
