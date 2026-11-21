import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { FolderOperations } from './factory-ui/folder-operations.mjs';
import { moveStoredIssue, updateStoredIssueMetadata } from './factory-ui/issue-report-storage.mjs';
import { changeFolderStrategy, folderStrategies, folderStrategy } from './factory-ui/folder-strategies.mjs';
import { readFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { readProjectSettings } from './factory-ui/project-settings.mjs';

function fixture(t, search) {
  const { root, git } = gitFixture(t, 'folder-operations-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.issues/triage-labels.md'), readProjectSettings(root).lifecycle.content);
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'original');
  git('branch', 'dev');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueCleanupTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map(), tasks: new Map() },
    ownServer() {},
  };
  const flows = createIssueFlows(service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: {
      async run() {
        return { summary: 'Fixture stopped.' };
      },
      close() {},
    },
    clarify: async () => ({ artifacts: { values: { type: 'feature', goal: 'Fixture' } } }),
  });
  t.after(() => flows.close());
  const operations = new FolderOperations(flows, search);
  const capture = async (description, fields = {}) => {
    const result = await flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description,
      folder: 'Inbox',
      ...fields,
    });
    return result.issue.id;
  };
  return { root, service, flows, operations, capture };
}

test('AI Search receives every issue in the selected folder view and cannot select an unknown issue', async (t) => {
  const calls = [];
  const { flows, operations, capture, root } = fixture(t, async (query, issues) => {
    calls.push({ query, issues });
    return [{ id: issues[1].id, reason: 'Matches the requested behavior.' }];
  });
  const first = await capture('Find the save problem.');
  const second = await capture('Repair the edit experience.');
  const closed = await capture('A closed request.');
  updateStoredIssueMetadata(root, flows.selected(closed), { state: 'closed' });
  moveStoredIssue(root, closed, 'open', 'closed');
  const result = await operations.action({
    action: 'folder-ai-search',
    folder: 'Inbox',
    view: 'open',
    query: 'editing',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(new Set(calls[0].issues.map(({ id }) => id)), new Set([first, second]));
  assert.equal(
    calls[0].issues.every(({ content }) => content.includes('Original request')),
    true
  );
  assert.equal(result.matches.length, 1);
  operations.search = async () => [{ id: closed, reason: 'Invalid out-of-view result.' }];
  await assert.rejects(operations.find({ folder: 'Inbox', view: 'open', query: 'anything' }), /unknown issue/);
});

test('AI Search rejects a stale folder and processes complete large issue content in parts', async (t) => {
  const calls = [];
  const { flows, operations, capture, root } = fixture(t, async (_query, batch) => {
    calls.push(batch);
    return [];
  });
  const id = await capture('Large report.');
  const path = join(root, '.issues', id + '.md');
  const original = readFileSync(path, 'utf8');
  const content = original + '\n' + 'z'.repeat(160000);
  writeFileSync(path, content);
  await operations.find({ folder: 'Inbox', view: 'open', query: 'find something' });
  assert.equal(calls.length > 1, true);
  assert.equal(
    calls
      .flat()
      .map((row) => row.content)
      .join(''),
    content
  );
  operations.search = async () => {
    updateStoredIssueMetadata(root, flows.selected(id), { title: 'Changed while searching' });
    return [];
  };
  await assert.rejects(operations.find({ folder: 'Inbox', view: 'open', query: 'again' }), /changed during AI Search/);
});

test('bulk archive binds the preview and retains per-issue failures without moving changed reports', async (t) => {
  const { flows, operations, capture, root } = fixture(t);
  const first = await capture('Archive the first request.');
  const second = await capture('Archive the changed request.');
  for (const id of [first, second]) {
    updateStoredIssueMetadata(root, flows.selected(id), { state: 'closed' });
    moveStoredIssue(root, id, 'open', 'closed');
  }
  const preview = operations.preview({ folder: 'Inbox', view: 'closed', issueIds: [first, second] });
  updateStoredIssueMetadata(root, flows.selected(second), { title: 'Changed after preview' });
  const result = await operations.run({ previewId: preview.id });
  assert.equal(result.results[0].status, 'archived', JSON.stringify(result.results));
  assert.equal(result.results[1].status, 'failed');
  assert.match(result.results[1].error, /changed after preview/);
  assert.equal(existsSync(join(root, '.issues/archive', first + '.md')), true);
  assert.equal(existsSync(join(root, '.issues/closed', second + '.md')), true);
  await assert.rejects(operations.run({ previewId: preview.id }), /Preview this selection again/);
});

test('strategy copies are editable files and preserve the original while rejecting stale selection changes', (t) => {
  const { flows, root } = fixture(t);
  const before = folderStrategies(root, 'Inbox');
  const original = folderStrategy(root, 'same-blast-radius');
  const result = changeFolderStrategy(root, {
    folder: 'Inbox',
    action: 'copy',
    strategy: original.id,
    revision: before.revision,
  });
  assert.match(result.selected, /^user\/selection-strategies\/.+\.md$/);
  const path = join(root, result.selected);
  assert.match(readFileSync(path, 'utf8'), /Select issues with a concrete overlap/);
  writeFileSync(path, '# My strategy\n\nPrefer save regressions.\n');
  assert.match(folderStrategy(root, result.selected).prompt, /Prefer save regressions/);
  assert.deepEqual(folderStrategy(root, original.id), original);
  assert.equal(
    readFolderSettings(root, flows.inboxFolder.directory).settings.selection_strategy.value,
    result.selected
  );
  assert.throws(
    () =>
      changeFolderStrategy(root, {
        folder: 'Inbox',
        action: 'select',
        strategy: original.id,
        revision: before.revision,
      }),
    /changed/
  );
});

test('bulk Start preserves approval stops and continues independent eligible issues without grouping', async (t) => {
  const { flows, operations, capture } = fixture(t);
  const pending = await capture('Requires an explicit approval.', { needsApproval: true });
  const ready = await capture('Independent work can start.');
  const preview = operations.preview({ folder: 'Inbox', view: 'open', issueIds: [pending, ready] });
  assert.equal(flows.autoplay.size, 0);
  const report = await operations.run({ previewId: preview.id });
  assert.equal(report.results[0].status, 'failed');
  assert.match(report.results[0].error, /approv/i);
  assert.equal(report.results[1].status, 'started', JSON.stringify(report.results));
  assert.equal(flows.selected(pending).issue_group, undefined);
  assert.equal(flows.selected(ready).issue_group, undefined);
  flows.pause(ready, 'End fixture');
});
