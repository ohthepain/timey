import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnection } from './factory-ui/codex.mjs';
import {
  newChatModelSettings,
  readIssueModelSettings,
  readModelSettings,
  saveDefaultModelSettings,
  saveIssueModelSettings,
} from './factory-ui/model-settings.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-model-settings-'));
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'factory.config.json'), '{"factoryModel":"gpt-6-luna","clarification":"combined"}\n');
  writeFileSync(join(root, '.issues/issue-one.md'), '---\nid: issue-one\n---\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = { root, ownServer() {} };
  return { root, service };
}

test('model settings default to GPT-6 Luna and medium and expose the four requested models and efforts', (t) => {
  const { root } = project(t);
  const settings = readModelSettings(root);
  assert.deepEqual(settings.defaults, { model: 'gpt-6-luna', effort: 'medium' });
  assert.deepEqual(
    settings.models.map(({ id }) => id),
    ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra']
  );
  assert.deepEqual(settings.efforts, ['low', 'medium', 'high', 'max']);
  assert.ok(settings.models.every(({ description }) => description.length > 0));
});

test('global defaults are saved locally without changing tracked factory configuration', (t) => {
  const { root, service } = project(t);
  const configBefore = readFileSync(join(root, 'factory.config.json'), 'utf8');
  saveDefaultModelSettings(service, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(readModelSettings(root).defaults, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(readFileSync(join(root, 'factory.config.json'), 'utf8'), configBefore);
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
