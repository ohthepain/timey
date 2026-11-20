import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { deliveryTarget } from './factory-ui/flow-block-data.mjs';
import { executionBlockSkill } from './factory-ui/issue-execution-settings.mjs';
import { readFolderSettings, updateFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { readIssueModelSettings, newChatModelSettings } from './factory-ui/model-settings.mjs';
import { moveStoredIssue } from './factory-ui/issue-report-storage.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'flow-folder-settings-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'original');
  git('branch', 'dev');
  git('branch', 'release');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const executions = [];
  const flows = createIssueFlows(service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: {
      async run(ctx) {
        executions.push(ctx);
        return { summary: 'Fixture completed.', artifacts: {} };
      },
      close() {},
    },
  });
  t.after(() => flows.close());
  const settings = (name, changes, extra = {}) => {
    const directory = name ? join(root, 'user', name) : root;
    const view = readFolderSettings(root, directory);
    return updateFolderSettings(root, { directory: view.folder.directory, revision: view.revision, changes, ...extra });
  };
  const capture = async (folder) =>
    (
      await flows.action({
        action: 'capture',
        requestId: randomUUID(),
        description: 'Keep the saved value.',
        ...(folder && { folder }),
      })
    ).issue.id;
  return { root, service, flows, settings, capture, executions };
}

test('Folder defaults choose capture destination and idle issue values while explicit overrides survive changes', async (t) => {
  const { flows, settings, capture } = fixture(t);
  await flows.action({ action: 'create-folder', name: 'Release' });
  settings('Release', { branch: 'release', model: 'gpt-6.1-sol', effort: 'high' }, { makeDefault: true });
  const id = await capture();
  let view = await flows.view(id);
  assert.equal(view.flow.folder, 'Release');
  assert.equal(view.flow.startingPoint.ref, 'refs/heads/release');
  assert.equal(deliveryTarget(view.flow).branch, 'release');
  assert.equal(view.issueSettings.values.model, 'gpt-6.1-sol');
  view = await flows.action({
    action: 'issue-settings',
    issueId: id,
    revision: view.flow.revision,
    changes: { branch: 'dev', model: 'gpt-6-astra' },
  });
  settings('Release', { branch: 'dev', model: 'gpt-6.1-terra', effort: 'low' });
  view = await flows.view(id);
  assert.equal(view.issueSettings.values.model, 'gpt-6-astra');
  assert.equal(view.issueSettings.values.effort, 'low');
  assert.equal(deliveryTarget(view.flow).branch, 'dev');
  assert.equal(view.flow.startingPoint.ref, 'refs/heads/release');
  view = await flows.action({
    action: 'issue-settings',
    issueId: id,
    revision: view.flow.revision,
    changes: { model: 'default' },
  });
  assert.equal(view.issueSettings.values.model, 'gpt-6.1-terra');
});

test('Grouping requires the resolved folder destination and rejects a settings change after preview', async (t) => {
  const { flows, settings, capture } = fixture(t);
  const ids = [await capture('Inbox'), await capture('Inbox')];
  let view = await flows.view(ids[0]);
  await flows.action({
    action: 'issue-settings',
    issueId: ids[0],
    revision: view.flow.revision,
    changes: { branch: 'release' },
  });
  let index = await flows.view();
  assert.equal(index.issues.find(({ id }) => id === ids[0]).folderEligible, true);
  assert.equal(index.issues.find(({ id }) => id === ids[0]).groupEligible, false);
  await assert.rejects(
    flows.action({ action: 'folder-group-preview', folder: 'Inbox', issueIds: ids }),
    /unstarted issue/
  );
  view = await flows.view(ids[0]);
  await flows.action({
    action: 'issue-settings',
    issueId: ids[0],
    revision: view.flow.revision,
    changes: { branch: 'dev' },
  });
  index = await flows.view();
  assert.equal(index.issues.find(({ id }) => id === ids[0]).groupEligible, true);
  const preview = await flows.action({ action: 'folder-group-preview', folder: 'Inbox', issueIds: ids });
  settings('Inbox', { effort: 'high' });
  await assert.rejects(
    flows.action({
      action: 'folder-group-create',
      previewId: preview.id,
      requestId: randomUUID(),
      wording: preview.wording,
    }),
    /changed/
  );
});

test('Execution freezes resolved settings and later folder edits do not retarget saved work', async (t) => {
  const { root, flows, settings, capture, executions } = fixture(t);
  settings('Inbox', { model: 'gpt-6.1-sol', effort: 'high', skill: 'poteto-mode' });
  const id = await capture('Inbox');
  let flow = flows.read(flows.selected(id));
  const request = flow.blocks.find((block) => block.kind === 'request');
  const work = flow.blocks.find((block) => block.kind === 'work');
  request.data.fields = { type: 'feature' };
  work.after = [request.id];
  flow.blocks = [request, work];
  flow = flows.store.save(flow, flow.revision);
  await flows.action({ action: 'start', issueId: id, blockId: work.id, revision: flow.revision });
  await flows.active.get(id)?.task;
  assert.equal(executions[0].flow.executionSettings.values.model, 'gpt-6.1-sol');
  settings('Inbox', { branch: 'release', model: 'gpt-6-astra', effort: 'low' });
  const view = await flows.view(id);
  assert.equal(view.issueSettings.frozen, true);
  assert.equal(deliveryTarget(view.flow).branch, 'dev');
  assert.equal(view.issueSettings.values.model, 'gpt-6.1-sol');
  assert.deepEqual(newChatModelSettings(root, id), { model: 'gpt-6.1-sol', effort: 'high' });
  await assert.rejects(
    flows.action({ action: 'issue-settings', issueId: id, revision: view.flow.revision, changes: { effort: 'max' } }),
    /fixed after execution/
  );
});

test('Inherited work skill overrides catalog defaults while explicit block choices retain precedence', () => {
  const definition = { defaultSkill: 'arena' };
  const inherited = { values: { skill: 'poteto-mode' } };
  const block = { kind: 'work', skill: 'arena', skillExplicit: false };
  assert.equal(executionBlockSkill(block, definition, inherited), 'poteto-mode');
  assert.equal(executionBlockSkill({ ...block, skillExplicit: true }, definition, inherited), 'arena');
  assert.equal(executionBlockSkill({ ...block, skill: null, skillExplicit: true }, definition, inherited), null);
  assert.equal(executionBlockSkill({ ...block, kind: 'advice' }, definition, inherited), 'arena');
});

test('Legacy per-issue model choices survive project defaults migration and can explicitly return to inheritance', async (t) => {
  const { root, flows, settings, capture } = fixture(t);
  const id = await capture('Inbox');
  writeFileSync(
    join(root, '.issues/model-settings.json'),
    JSON.stringify({ issues: { [id]: { model: 'gpt-6-astra' } } })
  );
  settings(null, { model: 'gpt-6.1-sol' });
  assert.equal(readIssueModelSettings(root, id).effectiveModel, 'gpt-6-astra');
  const view = await flows.view(id);
  await flows.action({
    action: 'issue-settings',
    issueId: id,
    revision: view.flow.revision,
    changes: { model: 'default' },
  });
  assert.equal(readIssueModelSettings(root, id).effectiveModel, 'gpt-6.1-sol');
  assert.equal(
    JSON.parse(readFileSync(join(root, '.issues/model-settings.json'), 'utf8')).issues[id].model,
    'gpt-6-astra'
  );
  assert.equal(existsSync(join(root, 'folder.md')), true);
});

test('Startup restores a missing issue-folder marker without changing its stable assignments', async (t) => {
  const { root, service, flows, capture } = fixture(t);
  await flows.action({ action: 'create-folder', name: 'Restored' });
  const id = await capture('Restored');
  const report = flows.selected(id);
  const marker = join(root, 'user/Restored/folder.md');
  unlinkSync(marker);
  const reopened = createIssueFlows(service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: { close() {} },
  });
  t.after(() => reopened.close());
  assert.equal(readFolderSettings(root, join(root, 'user/Restored')).folder.id, report.folder_id);
  assert.equal(reopened.selected(id).content, report.content);
  assert.equal(reopened.read(reopened.selected(id)).folder, 'Restored');
});

test('The current default folder cannot be deleted even when it has no issues', (t) => {
  const { flows } = fixture(t);
  const preview = flows.previewFolderDeletion({ folder: 'Inbox' });
  assert.equal(preview.canDelete, false);
  assert.match(preview.reason, /replacement default/);
});

test('A destination selected through the existing picker remains an explicit issue setting', async (t) => {
  const { flows, capture } = fixture(t);
  const id = await capture('Inbox');
  const flow = flows.read(flows.selected(id));
  flow.destination = { branch: 'release' };
  flows.store.save(flow, flow.revision);
  const view = await flows.view(id);
  assert.equal(view.issueSettings.overrides.branch, 'release');
  const saved = await flows.action({
    action: 'issue-settings',
    issueId: id,
    revision: view.flow.revision,
    changes: { ...view.issueSettings.overrides, effort: 'high' },
  });
  assert.equal(deliveryTarget(saved.flow).branch, 'release');
});

test('Copied folder identities stay repairable in the index and protect assigned issues from deletion', async (t) => {
  const { root, flows, capture } = fixture(t);
  await flows.action({ action: 'create-folder', name: 'Original' });
  await capture('Original');
  cpSync(join(root, 'user/Original'), join(root, 'user/Copy'), { recursive: true });
  const index = await flows.view();
  for (const name of ['Original', 'Copy']) {
    assert.ok(index.issueFolders.includes(name));
    assert.ok(index.folderSettings.find((folder) => folder.name === name).errors.some(({ key }) => key === 'id'));
    assert.equal(flows.previewFolderDeletion({ root: 'user', path: name }).canDelete, false);
  }
});

test('Archived issue model reads retain their explicit override and folder defaults', async (t) => {
  const { root, flows, capture } = fixture(t);
  const id = await capture('Inbox');
  const view = await flows.view(id);
  await flows.action({
    action: 'issue-settings',
    issueId: id,
    revision: view.flow.revision,
    changes: { model: 'gpt-6-astra' },
  });
  moveStoredIssue(root, id, 'open', 'closed');
  moveStoredIssue(root, id, 'closed', 'archive');
  assert.equal(readIssueModelSettings(root, id).effectiveModel, 'gpt-6-astra');
});
