import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assignIssueFolder, createIssueFolder, readIssueFolders } from './factory-ui/issue-folders.mjs';

test('issue folders persist separately from report content and reject stale organization changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-issue-folders-'));
  const issueDirectory = join(root, '.issues');
  mkdirSync(issueDirectory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = join(issueDirectory, '20261116-test.md');
  const report = '---\nid: 20261116-test\ntitle: Keep this title\nstate: qa\n---\nReport body stays the same.\n';
  writeFileSync(reportPath, report);
  const issues = [{ id: '20261116-test', title: 'Keep this title', state: 'qa', content: report }];
  const empty = readIssueFolders(root, issues);
  assert.equal(empty.folders[0].name, 'Inbox');
  assert.equal(issues[0].folderId, empty.folders[0].id);
  const created = createIssueFolder(root, issues, { name: 'Sprint', basis: empty.basis });
  assert.equal(created.folder.name, 'Sprint');
  const assigned = assignIssueFolder(root, issues, {
    issueId: issues[0].id,
    folderId: created.folder.id,
    basis: created.basis,
  });
  assert.equal(assigned.assignments[issues[0].id], created.folder.id);
  assert.equal(issues[0].title, 'Keep this title');
  assert.equal(issues[0].state, 'qa');
  assert.equal(readFileSync(reportPath, 'utf8'), report);
  assert.throws(
    () => assignIssueFolder(root, issues, { issueId: issues[0].id, folderId: null, basis: created.basis }),
    /folders changed/
  );
  assert.throws(
    () =>
      assignIssueFolder(root, issues, {
        issueId: issues[0].id,
        folderId: null,
        basis: assigned.basis,
      }),
    /Choose a current issue folder/
  );
  assert.deepEqual(JSON.parse(readFileSync(join(issueDirectory, 'issue-folders.json'), 'utf8')).folders, [
    created.folder,
  ]);
  assert.throws(() => createIssueFolder(root, issues, { name: ' sprint ', basis: assigned.basis }), /already exists/);
});
