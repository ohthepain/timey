import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnection } from './factory-ui/codex.mjs';
import { attachIssueChat } from './factory-ui/issue-chat-runtime.mjs';
import { gitFixture } from './git-fixture.mjs';
import { investigationSnapshot, removeInvestigationSnapshot } from './factory-ui/investigation-snapshot.mjs';
import { readStoreConfig, writeStoreConfig } from './factory-ui/stores/config.mjs';
import {
  newChatModelSettings,
  codexHelperModelSettings,
  readIssueModelSettings,
  readModelSettings,
  saveDefaultModelSettings,
  saveIssueModelSettings,
} from './factory-ui/model-settings.mjs';
import { initializeFolderSettings, createIssueFolderSettings } from './factory-ui/issue-folder-settings.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-model-settings-'));
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'factory.config.json'), '{"factoryModel":"gpt-6-luna","clarification":"combined"}\n');
  writeFileSync(join(root, '.issues/issue-one.md'), '---\nid: issue-one\n---\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = { root, ownServer() {} };
  return { root, service };
}

test('investigation chat startup uses the main project registry while running in an isolated snapshot', async (t) => {
  const { root, git } = gitFixture(t, 'settings-snapshot-');
  mkdirSync(join(root, '.issues'));
  initializeFolderSettings(root);
  const { revision, ...config } = readStoreConfig(root);
  writeStoreConfig(
    root,
    {
      ...config,
      profiles: [
        ...config.profiles,
        { id: 'postgres', label: 'Configured profile', issueStore: 'files', artifactStore: 'files' },
      ],
    },
    { expectedRevision: revision }
  );
  const path = join(root, 'folder.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/storage_profile: .*/, 'storage_profile: postgres'));
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  git('add', '.');
  git('commit', '-qm', 'Configured storage profile');
  const snapshot = investigationSnapshot(root, git('rev-parse', 'HEAD'));
  t.after(() => removeInvestigationSnapshot(snapshot));
  assert.deepEqual(readModelSettings(root).errors, []);
  assert.ok(readModelSettings(snapshot.checkout).errors.some(({ key }) => key === 'storage_profile'));
  const connection = new CodexConnection({ root, model: 'gpt-6-luna' });
  connection.ready = async () => {};
  const requests = [];
  connection.call = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: 'isolated-investigation' } };
  };
  await attachIssueChat(
    connection,
    snapshot.checkout,
    {},
    () => {},
    'workspace-write',
    'Inspect this source snapshot.'
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'thread/start');
  assert.equal(requests[0].params.cwd, snapshot.checkout);
  assert.equal(requests[0].params.model, 'gpt-6-luna');
  assert.equal(requests[0].params.sandbox, 'workspace-write');
  assert.equal(connection.root, root);
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('storage_profile: postgres', 'storage_profile: missing-profile')
  );
  await assert.rejects(
    attachIssueChat(connection, snapshot.checkout, {}, () => {}),
    /storage profile in project settings \(folder.md\):.*missing-profile/
  );
  assert.equal(requests.length, 1, 'Invalid main-project settings must still block thread creation.');
});

test('invalid inherited chat settings name the field, saved value and file to repair', (t) => {
  const { root } = project(t);
  initializeFolderSettings(root);
  createIssueFolderSettings(root, 'Repairs');
  createIssueFolderSettings(root, 'Repairs/Child');
  const folder = join(root, 'user/Repairs/folder.md');
  const original = readFileSync(folder, 'utf8');
  assert.match(original, /effort: "default"/);
  writeFileSync(folder, original.replace('effort: "default"', 'effort: impossible'));
  mkdirSync(join(root, '.issues/flows/issue-one'), { recursive: true });
  writeFileSync(
    join(root, '.issues/flows/issue-one/flow.json'),
    JSON.stringify({ issueId: 'issue-one', folder: 'Repairs/Child', blocks: [] })
  );
  assert.throws(
    () => newChatModelSettings(root, 'issue-one'),
    (error) => {
      assert.match(error.message, /effort/i);
      assert.match(error.message, /impossible/);
      assert.match(error.message, /user\/Repairs\/folder.md/);
      assert.match(error.message, /Choose a listed effort/);
      return true;
    }
  );
});

test('invalid issue overrides and malformed project settings identify their own repair location', (t) => {
  const { root } = project(t);
  initializeFolderSettings(root);
  writeFileSync(
    join(root, '.issues/model-settings.json'),
    JSON.stringify({ issues: { 'issue-one': { effort: 'broken-effort' } } })
  );
  assert.throws(() => newChatModelSettings(root, 'issue-one'), /effort in Issue settings:.*broken-effort/);
  writeFileSync(join(root, 'folder.md'), '---\nmodel: [broken\n---\n');
  assert.throws(
    () => newChatModelSettings(root),
    (error) => {
      assert.match(error.message, /file in project settings \(folder.md\)/);
      assert.match(error.message, /collection|sequence|flow/i);
      return true;
    }
  );
});

test('model settings retain Codex defaults and expose the supported native agent models', (t) => {
  const { root } = project(t);
  const settings = readModelSettings(root);
  assert.deepEqual(settings.defaults, { model: 'gpt-6-luna', effort: 'medium' });
  assert.deepEqual(
    settings.models.map(({ id }) => id),
    [
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-astra',
      'anthropic:sonnet',
      'anthropic:opus',
      'google:pro',
      'google:flash',
    ]
  );
  assert.deepEqual(settings.efforts, ['low', 'medium', 'high', 'max']);
  assert.ok(settings.models.every(({ description }) => description.length > 0));
  assert.ok(
    settings.models.filter(({ provider }) => provider !== 'codex').every(({ supportsEffort }) => !supportsEffort)
  );
});

test('native model defaults and issue overrides use existing inheritance', (t) => {
  const { root, service } = project(t);
  saveDefaultModelSettings(service, { model: 'anthropic:sonnet', effort: 'medium' });
  assert.equal(newChatModelSettings(root, 'issue-one').model, 'anthropic:sonnet');
  assert.deepEqual(codexHelperModelSettings(root), { model: 'gpt-6-luna', effort: 'medium' });
  saveIssueModelSettings(service, { issueId: 'issue-one', model: 'google:flash', effort: '' });
  assert.equal(newChatModelSettings(root, 'issue-one').model, 'google:flash');
  saveIssueModelSettings(service, { issueId: 'issue-one', model: '', effort: '' });
  assert.equal(newChatModelSettings(root, 'issue-one').model, 'anthropic:sonnet');
});

test('the named Codex reviewer opens with its explicit model when project defaults use another agent', async (t) => {
  const { root, service } = project(t);
  saveDefaultModelSettings(service, { model: 'google:pro', effort: 'medium' });
  const connection = new CodexConnection({ model: 'gpt-6.1-sol' });
  connection.ready = async () => {};
  const calls = [];
  connection.call = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'reviewer' } };
  };
  await connection.start(root);
  assert.equal(calls[0].params.model, 'gpt-6.1-sol');
});

test('project model defaults are saved in root folder.md while preserving factory configuration', (t) => {
  const { root, service } = project(t);
  const configBefore = readFileSync(join(root, 'factory.config.json'), 'utf8');
  saveDefaultModelSettings(service, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(readModelSettings(root).defaults, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(readFileSync(join(root, 'factory.config.json'), 'utf8'), configBefore);
  assert.match(readFileSync(join(root, 'folder.md'), 'utf8'), /model: ["']?gpt-6\.1-sol/);
  assert.deepEqual(newChatModelSettings(root), { model: 'gpt-6.1-sol', effort: 'high' });
});

test('issue choices stay explicit while unset fields follow changed defaults', (t) => {
  const { root, service } = project(t);
  saveIssueModelSettings(service, { issueId: 'issue-one', model: 'gpt-6-astra', effort: '' });
  assert.deepEqual(readIssueModelSettings(root, 'issue-one'), {
    model: 'gpt-6-astra',
    effort: '',
    effectiveModel: 'gpt-6-astra',
    effectiveEffort: 'medium',
  });
  saveDefaultModelSettings(service, { model: 'gpt-6.1-terra', effort: 'high' });
  assert.deepEqual(newChatModelSettings(root, 'issue-one'), { model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(readIssueModelSettings(root, 'issue-one').effectiveModel, 'gpt-6-astra');
  saveIssueModelSettings(service, { issueId: 'issue-one', model: '', effort: 'low' });
  assert.deepEqual(newChatModelSettings(root, 'issue-one'), { model: 'gpt-6.1-terra', effort: 'low' });
});

test('new Codex threads receive the effective model and preserve the selected sandbox', async (t) => {
  const { root, service } = project(t);
  saveDefaultModelSettings(service, { model: 'gpt-6.1-sol', effort: 'high' });
  saveIssueModelSettings(service, { issueId: 'issue-one', model: 'gpt-6-astra', effort: 'low' });
  const connection = new CodexConnection();
  connection.ready = async () => {};
  let request;
  connection.call = async (method, params) => {
    request = { method, params };
    return { thread: { id: 'new-thread' } };
  };
  await connection.start(root, 'read-only', () => {}, 'issue-one');
  assert.equal(request.method, 'thread/start');
  assert.equal(request.params.model, 'gpt-6-astra');
  assert.equal(request.params.sandbox, 'read-only');
  assert.equal(service.root, root);
});

test('each new work turn receives the latest effective model and effort', async (t) => {
  const { root, service } = project(t);
  saveDefaultModelSettings(service, { model: 'gpt-6.1-sol', effort: 'high' });
  saveIssueModelSettings(service, { issueId: 'issue-one', model: 'gpt-6-astra', effort: 'low' });
  const connection = new CodexConnection();
  let request;
  connection.call = async (method, params) => {
    request = { method, params };
    queueMicrotask(() =>
      connection.event({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { status: 'completed' } } })
    );
    return { turn: { id: 'turn-one' } };
  };
  await connection.turn('thread-one', root, 'new work', null, [], newChatModelSettings(root, 'issue-one'));
  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.model, 'gpt-6-astra');
  assert.equal(request.params.effort, 'low');
});

test('invalid selections and missing issue IDs are rejected', (t) => {
  const { service } = project(t);
  assert.throws(() => saveDefaultModelSettings(service, { model: 'custom', effort: 'medium' }), /listed models/);
  assert.throws(
    () => saveIssueModelSettings(service, { issueId: 'missing', model: '', effort: '' }),
    /no longer exists/
  );
  assert.throws(
    () => saveIssueModelSettings(service, { issueId: 'issue-one', model: '', effort: 'xhigh' }),
    /listed effort levels/
  );
});

test('reading legacy model defaults preserves them without creating project settings files', (t) => {
  const { root } = project(t);
  writeFileSync(join(root, 'factory.config.json'), '{"factoryModel":"gpt-6.1-sol","factoryEffort":"high"}');
  assert.deepEqual(readModelSettings(root).defaults, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(existsSync(join(root, 'folder.md')), false);
  assert.equal(existsSync(join(root, 'user/Inbox/folder.md')), false);
});
