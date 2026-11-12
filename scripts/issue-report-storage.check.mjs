import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decideIssue } from './factory-ui/issue-decision.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { humanGuard } from './factory-ui/guard.mjs';
import { readSavedReport } from './factory-ui/report-document.mjs';
import {
  listStoredIssues,
  migrateClosedIssues,
  moveStoredIssue,
  storedIssuePath,
} from './factory-ui/issue-report-storage.mjs';

const id = '20261112T125500000-ea34';
const report = (state) => `---\nid: ${id}\ntitle: Saved issue\nstate: ${state}\n---\n\nPreserve this text.\n`;

function fixture(t) {
  const { root, git } = gitFixture(t, 'timey-issue-storage-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-for-repro | investigate | finished |\n| closed | finished | — |\n\n## Closed reasons\n\n| ID | Label | Meaning |\n| --- | --- | --- |\n| wont-do | Won’t Do | The work was dismissed. |\n'
  );
  const scripts = join(root, '.agents/skills/issues/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json']) {
    cpSync(resolve('.agents/skills/issues/scripts', name), join(scripts, name));
  }
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { root, git };
}

test('closing and reopening keep one report, its number, and its history', (t) => {
  const { root } = fixture(t);
  writeFileSync(storedIssuePath(root, id), report('investigate'));
  const service = {
    root,
    ownServer() {},
    guard: humanGuard,
    lifecycleTasks: new Map(),
    store: {
      runs: [],
      connected: new Set(),
      add: () => ({ id: 'fixture' }),
      update() {},
    },
  };
  const queue = readQueue(root);
  const issue = queue.issues[0];
  assert.deepEqual(
    decideIssue(service, id, issue.state, 'close', decisionBasis(queue, issue), 'No longer needed.', 'wont-do'),
    { state: 'finished' }
  );
  assert.deepEqual(readQueue(root).issues, []);
  assert.equal(existsSync(storedIssuePath(root, id)), false);
  const closed = readQueue(root, { location: 'closed', issueId: id });
  assert.equal(closed.issues[0].issueNumber, issue.issueNumber);
  assert.match(readSavedReport(root, id).content, /No longer needed\./);
  assert.deepEqual(
    decideIssue(service, id, 'finished', 'reopen', decisionBasis(closed, closed.issues[0]), 'Needs another look.'),
    { state: 'investigate' }
  );
  assert.equal(existsSync(storedIssuePath(root, id, 'closed')), false);
  const reopened = readQueue(root).issues[0];
  assert.equal(reopened.issueNumber, issue.issueNumber);
  assert.match(reopened.content, /Preserve this text/);
  assert.match(reopened.content, /No longer needed/);
  assert.match(reopened.content, /Needs another look/);
});

test('migration follows the configured closed role and moves the exact report once', (t) => {
  const { root } = fixture(t);
  const original = report('finished');
  writeFileSync(storedIssuePath(root, id), original);
  assert.deepEqual(migrateClosedIssues(root), [id]);
  assert.deepEqual(migrateClosedIssues(root), []);
  assert.deepEqual(listStoredIssues(root), []);
  assert.equal(readFileSync(storedIssuePath(root, id, 'closed'), 'utf8'), original);
});

test('migration leaves tracked reports for the reviewed shared update', (t) => {
  const { root, git } = fixture(t);
  const path = storedIssuePath(root, id);
  writeFileSync(path, report('finished'));
  git('add', '-f', path);
  git('commit', '-qm', 'Track report');
  assert.deepEqual(migrateClosedIssues(root), []);
  assert.equal(readFileSync(path, 'utf8'), report('finished'));
});

test('archive moves never overwrite a different file and can retry interrupted moves', (t) => {
  const { root } = fixture(t);
  const source = storedIssuePath(root, id, 'closed');
  const destination = storedIssuePath(root, id, 'archive');
  mkdirSync(join(root, '.issues/closed'));
  mkdirSync(join(root, '.issues/archive'));
  writeFileSync(source, report('finished'));
  writeFileSync(destination, report('different'));
  assert.throws(() => moveStoredIssue(root, id, 'closed', 'archive'), /already exists/);
  assert.equal(readFileSync(source, 'utf8'), report('finished'));
  assert.equal(readFileSync(destination, 'utf8'), report('different'));
  moveStoredIssue(root, id, 'archive', 'open');
  linkSync(source, destination);
  assert.equal(moveStoredIssue(root, id, 'closed', 'archive'), destination);
  assert.equal(moveStoredIssue(root, id, 'closed', 'archive'), destination);
  assert.equal(existsSync(source), false);
  assert.equal(readSavedReport(root, id, 'archive').content, report('finished'));
});

test('routine queue reads keep historical issue links without parsing closed report bodies', (t) => {
  const { root } = fixture(t);
  const other = '20261112T125500000-ea35';
  mkdirSync(join(root, '.issues/closed'));
  writeFileSync(storedIssuePath(root, other, 'closed'), 'Unreadable as a report.');
  writeFileSync(storedIssuePath(root, id), report('investigate') + `\n## Blocked by\n\n- ${other}\n`);
  const queue = readQueue(root);
  assert.deepEqual(
    queue.issues.map((issue) => issue.id),
    [id]
  );
  assert.deepEqual(queue.issues[0].links.depends, [other]);
});

test('bulk archive and restore use local files and export omits archived reports', async (t) => {
  const { listIssueStorage, moveIssueStorage } = await import('./factory-ui/issue-storage-actions.mjs');
  const { exportIssueReports } = await import('./factory-ui/issue-storage-export.mjs');
  const { root } = fixture(t);
  const other = '20261112T125500000-ea35';
  mkdirSync(join(root, '.issues/closed'));
  writeFileSync(storedIssuePath(root, id, 'closed'), report('finished'));
  writeFileSync(storedIssuePath(root, other, 'closed'), report('finished').replace(id, other));
  writeFileSync(
    join(root, '.issues/issue-numbers.json'),
    JSON.stringify({ version: 1, next: 3, issues: { [id]: 1, [other]: 2 } })
  );
  const service = {
    root,
    ownServer() {},
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    issueCleanupTasks: new Map(),
    store: { runs: [], connected: new Set() },
  };
  const move = (action, issueIds) => moveIssueStorage(service, { action, issueIds }).results.map((item) => item.status);
  assert.deepEqual(move('archive', [id, other, id]), ['archived', 'archived']);
  assert.equal(listIssueStorage(service, 'closed').issues.length, 0);
  assert.deepEqual(
    listIssueStorage(service, 'archive').issues.map((item) => item.issueNumber),
    [1, 2]
  );
  assert.deepEqual(move('restore', [other]), ['restored']);
  const result = exportIssueReports(root, join(root, 'export'));
  assert.equal(result.closed, 1);
  assert.equal(result.displayNumbers, 2);
  assert.equal(existsSync(join(result.destination, 'closed', id + '.md')), false);
  assert.equal(existsSync(join(result.destination, 'archive')), false);
  assert.equal(
    readFileSync(join(result.destination, 'closed', other + '.md'), 'utf8'),
    report('finished').replace(id, other)
  );
});
