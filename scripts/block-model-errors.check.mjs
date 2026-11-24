import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeBlock } from './factory-ui/flow-store.mjs';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { initializeProviderConfig, readProviderConfig } from './factory-ui/provider-config.mjs';
import { observeProvider, saveProviderSettings } from './factory-ui/provider-runtime.mjs';
import { saveConversationState } from './factory-ui/conversation-store.mjs';
import { blockExecutionSettings } from './factory-ui/block-models.mjs';
import { lastBlockingError, retainBlockingError, resolveBlockingErrors } from './factory-ui/block-errors.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'block-model-errors-');
  mkdirSync(join(root, '.issues'));
  initializeFolderSettings(root);
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('branch', 'dev');
  const id = '20261123-block-models';
  writeFileSync(join(root, '.issues', id + '.md'), `---\nid: ${id}\ntitle: Block models\nstate: backlog\n---\n`);
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const calls = [];
  function controller() {
    const flows = createIssueFlows(service, {
      observer: { observe: async () => ({}) },
      executor: {
        async run(ctx) {
          calls.push(ctx.attempt.modelSettings);
          return { summary: 'Done' };
        },
        close() {},
      },
    });
    service.flows = flows;
    t.after(() => flows.close());
    return flows;
  }
  const flows = controller();
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.settings = { model: 'anthropic:sonnet' };
  flow.blocks.find((b) => b.kind === 'request').data.fields = { type: 'feature', goal: 'Model selection' };
  flow.blocks
    .find((b) => b.kind === 'request')
    .attempts.push({ id: 'request-success', status: 'completed', startedAt: '2026-11-23T00:00:00Z' });
  flows.store.save(flow, flow.revision);
  const read = () => flows.read(issue);
  const action = (action, extra = {}) => flows.action({ issueId: id, revision: read().revision, action, ...extra });
  return { root, id, flows, issue, read, action, calls, controller };
}
function configure(root, enabled) {
  initializeProviderConfig(root);
  observeProvider(root, 'anthropic', {
    ready: true,
    models: ['sonnet', 'opus'].map((id) => ({ id: 'anthropic:' + id, name: id })),
  });
  observeProvider(root, 'google', { ready: true, models: [{ id: 'google:pro', name: 'Gemini Pro' }] });
  const config = readProviderConfig(root);
  config.providers.anthropic.enabled = enabled;
  config.providers.anthropic.allowUnmonitored = true;
  config.providers.google.enabled = ['google:pro'];
  config.providers.google.allowUnmonitored = true;
  saveProviderSettings(root, config);
}

test('Resume retains actionable inherited settings errors before starting any work', async (t) => {
  const { root, id, flows, read, action, calls, controller } = fixture(t);
  const path = join(root, 'folder.md');
  const original = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    original.replace(/effort: .*/, 'effort: impossible').replace(/skill: .*/, 'skill: missing-skill')
  );
  const before = read().blocks;
  await action('play');
  await new Promise(setImmediate);
  assert.equal(flows.autoplay.get(id).mode, 'paused');
  assert.deepEqual(read().blocks, before);
  assert.equal(calls.length, 0);
  const view = await controller().view(id);
  assert.match(view.lastBlockingError.message, /effort in folder.md/);
  assert.match(view.lastBlockingError.message, /Choose a listed effort/);
  assert.match(view.lastBlockingError.message, /impossible/);
  assert.match(view.lastBlockingError.message, /skill in folder.md/);
  assert.match(view.lastBlockingError.message, /missing-skill/);
});

test('an explicit block model bypasses only inherited model errors, preserving other repair details', (t) => {
  const { root, flows, issue, read } = fixture(t);
  const flow = read();
  flow.settings = {};
  const path = join(root, 'folder.md');
  const invalidModel = readFileSync(path, 'utf8').replace(/model: .*/, 'model: missing-model');
  writeFileSync(path, invalidModel);
  assert.throws(
    () => blockExecutionSettings(flows.service, issue, flow, {}, { validate: true }),
    /model in folder.md:.*missing-model/
  );
  assert.equal(
    blockExecutionSettings(flows.service, issue, flow, { model: 'gpt-6-luna' }, { validate: true }).model,
    'gpt-6-luna'
  );
  writeFileSync(path, invalidModel.replace(/effort: .*/, 'effort: impossible'));
  assert.throws(
    () => blockExecutionSettings(flows.service, issue, flow, { model: 'gpt-6-luna' }, { validate: true }),
    (error) => {
      assert.match(error.message, /effort in folder.md:.*impossible/);
      assert.doesNotMatch(error.message, /missing-model/);
      return true;
    }
  );
});

test('idle override preserves frozen defaults and completed history, then supplies the next attempt', async (t) => {
  const { flows, issue, read, action, calls } = fixture(t);
  const flow = read();
  flow.executionSettings = flows.issueSettings(issue, flow);
  const work = flow.blocks.find((b) => b.kind === 'work');
  const previous = {
    id: 'earlier-work',
    status: 'completed',
    startedAt: '2026-11-23T01:00:00Z',
    modelSettings: { model: 'anthropic:sonnet', effort: 'high' },
    summary: 'Keep result',
    result: { value: 42 },
  };
  work.attempts.push(previous);
  flows.store.save(flow, flow.revision);
  await action('update', { blockId: work.id, changes: { model: 'anthropic:opus' } });
  assert.deepEqual(read().blocks.find((b) => b.id === work.id).attempts[0], previous);
  assert.equal(read().executionSettings.values.model, 'anthropic:sonnet');
  assert.equal(calls.length, 0);
  const view = await flows.view(issue.id);
  assert.equal(view.blockModels[work.id].model, 'anthropic:opus');
  assert.equal(view.blockModels[work.id].defaultModel, 'anthropic:sonnet');
  await action('start', { blockId: work.id });
  await flows.active.get(issue.id)?.task;
  assert.equal(calls[0].model, 'anthropic:opus');
  assert.equal(read().blocks.find((b) => b.id === work.id).attempts[0].modelSettings.model, 'anthropic:sonnet');
});

test('unavailable inspection stays inline, rejected Start persists before an attempt and successful retry clears it', async (t) => {
  const { root, id, flows, read, action, controller } = fixture(t);
  configure(root, ['anthropic:opus']);
  const work = read().blocks.find((b) => b.kind === 'work');
  let view = await flows.view(id);
  assert.equal(view.blockModels[work.id].availability.status, 'disabled');
  assert.equal(view.lastBlockingError, null);
  await assert.rejects(action('start', { blockId: work.id }), /disabled|settings/i);
  assert.equal(read().blocks.find((b) => b.id === work.id).attempts.length, 0);
  const restarted = controller();
  view = await restarted.view(id);
  assert.equal(view.lastBlockingError.blockId, work.id);
  await restarted.view(id);
  assert.equal((await restarted.view(id)).lastBlockingError.id, view.lastBlockingError.id);
  await action('update', { blockId: work.id, changes: { model: 'anthropic:opus' } });
  assert.ok((await flows.view(id)).lastBlockingError);
  await action('start', { blockId: work.id });
  await flows.active.get(id)?.task;
  assert.equal((await flows.view(id)).lastBlockingError, null);
  assert.ok(read().blockingErrors[0].resolvedAt);
});

test('model edits reject active and unreconciled work and require a confirmed cross-provider handoff', async (t) => {
  const { root, id, flows, read, action } = fixture(t);
  const flow = read(),
    work = flow.blocks.find((b) => b.kind === 'work');
  work.attempts.push({ id: 'uncertain', status: 'uncertain', startedAt: '2026-11-23T01:00:00Z' });
  flows.store.save(flow, flow.revision);
  await assert.rejects(action('update', { blockId: work.id, changes: { model: 'google:pro' } }), /reconcile/);
  work.attempts[0].reconciledAt = new Date().toISOString();
  flows.store.save(flow, read().revision);
  saveConversationState(root, id, { flowBlocks: { [work.id]: { threadId: 'anthropic:old-session' } } });
  await assert.rejects(
    action('update', { blockId: work.id, changes: { model: 'google:pro' } }),
    /Confirm the provider handoff/
  );
  await action('update', { blockId: work.id, changes: { model: 'google:pro' }, confirmedModelHandoff: true });
  assert.equal(read().blocks.find((b) => b.id === work.id).modelHandoff.fromThreadId, 'anthropic:old-session');
  flows.active.set(id, { blockId: work.id });
  await assert.rejects(
    action('update', { blockId: work.id, changes: { model: 'anthropic:opus' } }),
    /active|Stop|running/i
  );
  flows.active.delete(id);
  assert.equal((await flows.view(id)).lastBlockingError.id, 'uncertain');
  assert.equal(read().blockingErrors, undefined, 'Settings failure must stay local.');
});

test('newest unresolved blocker survives reconciliation; success reveals older errors and removal preserves history', () => {
  const flow = {
    blocks: [
      {
        id: 'a',
        label: 'Work',
        attempts: [
          {
            id: 'old',
            status: 'failed',
            summary: 'Earlier work failed',
            endedAt: '2026-11-23T01:00:00Z',
            reconciledAt: 'later',
          },
        ],
      },
      { id: 'b', label: 'Verify', attempts: [] },
    ],
  };
  const next = retainBlockingError(flow, { action: 'start', blockId: 'b', error: Error('Verification is blocked') });
  assert.equal(lastBlockingError(flow).id, next.id);
  resolveBlockingErrors(flow, 'b');
  assert.equal(lastBlockingError(flow).message, 'Earlier work failed');
  flow.blocks[0].attempts.push({ id: 'success', status: 'completed' });
  assert.equal(lastBlockingError(flow), null);
  retainBlockingError(flow, { action: 'start', blockId: 'b', error: Error('Retain removal evidence') });
  flow.blocks.pop();
  assert.equal(lastBlockingError(flow), null);
  assert.equal(flow.blockingErrors.length, 2);
});

test('fixed helpers and command blocks do not offer a configurable model', async (t) => {
  const { flows, id, read, action } = fixture(t);
  const view = await flows.view(id);
  const request = read().blocks.find((b) => b.kind === 'request');
  assert.equal(view.blockModels[request.id].kind, 'fixed');
  assert.equal(view.blockModels[read().blocks.find((b) => b.kind === 'publish').id].kind, 'none');
  await assert.rejects(
    action('update', { blockId: request.id, changes: { model: 'google:pro' } }),
    /no editable model/
  );
});

test('skipping Retro resolves its blockers and closure failures remain visible until closure completes', () => {
  const flow = {
    blocks: [
      {
        id: 'retro',
        kind: 'retro',
        label: 'Retro',
        attempts: [{ id: 'retro-failure', status: 'failed', summary: 'Retro failed', endedAt: '2026-11-23T01:00:00Z' }],
      },
    ],
    closing: { error: 'Cleanup failed', errorAt: '2026-11-23T02:00:00Z' },
  };
  assert.equal(lastBlockingError(flow).message, 'Cleanup failed');
  flow.closing.complete = true;
  assert.equal(lastBlockingError(flow).message, 'Retro failed');
  retainBlockingError(flow, { action: 'continue', blockId: 'retro', error: Error('Retro needs a model') });
  flow.closing.skipRetro = true;
  resolveBlockingErrors(flow, 'retro');
  assert.equal(lastBlockingError(flow), null);
  assert.ok(flow.blockingErrors[0].resolvedAt);
  assert.equal(flow.blocks[0].attempts[0].status, 'failed');
});

test('a disabled required Sol model keeps its identity and blocking reason', async (t) => {
  const { root, id, flows, read } = fixture(t);
  const flow = read(),
    sol = makeBlock('sol');
  flow.blocks.push(sol);
  flows.store.save(flow, flow.revision);
  configure(root, ['anthropic:sonnet']);
  observeProvider(root, 'codex', { ready: true, models: [{ id: 'gpt-6.1-sol', name: 'Sol' }] });
  const config = readProviderConfig(root);
  config.providers.codex.enabled = [];
  saveProviderSettings(root, config);
  const model = (await flows.view(id)).blockModels[sol.id];
  assert.equal(model.kind, 'fixed');
  assert.equal(model.model, 'gpt-6.1-sol');
  assert.equal(model.availability.status, 'disabled');
});
