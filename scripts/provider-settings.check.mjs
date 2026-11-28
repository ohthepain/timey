import { CodexAccountConnection } from './factory-ui/codex-account.mjs';
import { CodexConnection } from './factory-ui/codex.mjs';
import { NativeAgentConnection } from './factory-ui/native-agent.mjs';
import { readModelSettings } from './factory-ui/model-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initializeProviderConfig,
  providerConfigPath,
  readProviderConfig,
  quotaAvailability,
} from './factory-ui/provider-config.mjs';
import {
  changeProviderEnabled,
  observeProvider,
  providerSettings,
  saveProviderSettings,
  modelAvailability,
  guardProviderWork,
  providerModelChoices,
} from './factory-ui/provider-runtime.mjs';
import { agentModel } from './factory-ui/agent-models.mjs';

const policy = { warning: 5, disable: 2, allowUnmonitored: false };
const now = 1800000000000;
const window = (remainingPercent, extra = {}) => ({
  remainingPercent,
  checkedAt: now,
  resetsAt: now / 1000 + 3600,
  ...extra,
});
const state = (windows, model = 'google:pro', overrides = {}, time = now) =>
  quotaAvailability({ ...policy, ...overrides }, { windows }, model, time);
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-providers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function configured(t) {
  const root = project(t);
  initializeProviderConfig(root);
  enable(root, 'google');
  observeProvider(root, 'google', {
    ready: true,
    models: [
      { id: 'google:pro', name: 'Gemini Pro' },
      { id: 'google:flash', name: 'Gemini Flash' },
    ],
  });
  const config = readProviderConfig(root);
  config.providers.google.enabled = ['google:pro'];
  config.providers.google.allowUnmonitored = true;
  saveProviderSettings(root, config);
  return root;
}

function enable(root, provider) {
  return changeProviderEnabled(root, { provider, active: true, revision: readProviderConfig(root).revision });
}

test('warning and disable thresholds include their boundary and lowest applicable window wins', () => {
  assert.equal(state([window(5)]).status, 'warning');
  assert.equal(state([window(2)]).status, 'disabled');
  assert.equal(state([window(2.1)]).status, 'warning');
  assert.equal(state([window(6), window(1)]).status, 'disabled');
  assert.equal(state([window(6)]).status, 'available');
});
test('model-specific allowance leaves independently available models usable', () => {
  const windows = [window(40), window(1, { models: ['google:pro'] })];
  assert.equal(state(windows, 'google:pro').status, 'disabled');
  assert.equal(state(windows, 'google:flash').status, 'available');
});
test('unknown, partially stale, expired and future-dated quota requires an explicit override', () => {
  for (const windows of [
    [],
    [window(80, { checkedAt: now - 120001 })],
    [window(80, { checkedAt: now + 1 })],
    [window(80, { resetsAt: now / 1000 - 1 })],
    [window(80), window(20, { checkedAt: now - 120001 })],
  ]) {
    assert.equal(state(windows).status, 'unknown');
    assert.equal(state(windows, 'google:pro', { allowUnmonitored: true }).status, 'unmonitored');
  }
});
test('unmonitored override cannot bypass confirmed exhaustion, including stale observations until reset', () => {
  const exhausted = window(0, { checkedAt: now - 300000 });
  assert.equal(state([exhausted], 'google:pro', { allowUnmonitored: true }).status, 'disabled');
  assert.equal(state([exhausted], 'google:pro', { allowUnmonitored: true }, now + 3601000).status, 'unmonitored');
});
test('migration preserves defaults, folder and issue overrides and frozen execution model references', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'user/team'), { recursive: true });
  mkdirSync(join(root, '.issues/flows'), { recursive: true });
  writeFileSync(join(root, '.issues/factory-discovery.json'), '{}');
  writeFileSync(join(root, 'folder.md'), '---\nmodel: anthropic:sonnet\n---\n');
  writeFileSync(join(root, 'user/team/folder.md'), '---\nmodel: google:pro\n---\n');
  writeFileSync(
    join(root, '.issues/model-settings.json'),
    JSON.stringify({ issues: { sample: { model: 'anthropic:opus' } } })
  );
  writeFileSync(
    join(root, '.issues/flows/old.json'),
    JSON.stringify({ executionSettings: { values: { model: 'google:flash' } } })
  );
  const config = initializeProviderConfig(root);
  assert.ok(Object.values(config.providers).every((provider) => provider.active));
  assert.deepEqual(config.providers.anthropic.enabled.sort(), ['anthropic:opus', 'anthropic:sonnet']);
  assert.deepEqual(config.providers.google.enabled.sort(), ['google:flash', 'google:pro']);
  assert.equal(config.providers.google.warning, 5);
  assert.equal(config.providers.google.disable, 2);
  assert.equal(initializeProviderConfig(root).revision, config.revision);
});

test('fresh installs disable every provider before opening Settings even with packaged model defaults', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'folder.md'), '---\nmodel: google:pro\n---\n');
  const config = initializeProviderConfig(root);
  assert.ok(Object.values(config.providers).every((provider) => !provider.active && !provider.enabled.length));
  assert.deepEqual(providerModelChoices(root), []);
  await assert.rejects(
    guardProviderWork(root, 'google:pro', () => {}),
    /Google is disabled/
  );
});

test('saved provider policies load with their previous availability and choices on upgrade', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'user'));
  const legacy = {
    codex: { ...policy, enabled: [] },
    anthropic: { ...policy, enabled: [] },
    google: { warning: 15, disable: 3, allowUnmonitored: true, enabled: ['google:pro'] },
  };
  const source = JSON.stringify(legacy);
  writeFileSync(providerConfigPath(root), source);
  observeProvider(root, 'google', { ready: true, models: [{ id: 'google:pro', name: 'Gemini Pro' }] });
  assert.deepEqual(
    initializeProviderConfig(root).providers,
    Object.fromEntries(Object.entries(legacy).map(([id, provider]) => [id, { active: true, ...provider }]))
  );
  assert.equal(readFileSync(providerConfigPath(root), 'utf8'), source);
  assert.equal(modelAvailability(root, 'google:pro').status, 'unmonitored');
});
test('discovered models start unchecked, enablement populates choices, missing selected models remain visible', (t) => {
  const root = configured(t);
  assert.deepEqual(
    providerModelChoices(root).map((entry) => entry.value),
    ['google:pro']
  );
  observeProvider(root, 'google', { ready: true, models: [{ id: 'google:flash', name: 'Gemini Flash' }] });
  assert.deepEqual(providerModelChoices(root), []);
  const saved = providerSettings(root).providers.find((entry) => entry.id === 'google');
  const missing = saved.models.find((entry) => entry.id === 'google:pro');
  assert.equal(missing.enabled, true);
  assert.equal(missing.availability.status, 'unavailable');
});
test('save rejects stale revisions, invalid thresholds and arbitrary model IDs', (t) => {
  const root = configured(t),
    config = readProviderConfig(root);
  assert.throws(() => saveProviderSettings(root, { ...config, revision: 'stale' }), /changed/);
  const invalid = structuredClone(config);
  invalid.providers.google.disable = 6;
  assert.throws(() => saveProviderSettings(root, invalid), /below warning/);
  invalid.providers.google.disable = 2;
  invalid.providers.google.enabled.push('google:invented');
  assert.throws(() => saveProviderSettings(root, invalid), /discovered model/);
});
test('manual disable interrupts affected work once, preserves other providers, and recovery never resumes work', async (t) => {
  const root = configured(t),
    stopped = [];
  const guard = await guardProviderWork(root, 'google:pro', (error) => stopped.push(error));
  t.after(() => guard.close());
  const config = readProviderConfig(root);
  config.providers.google.enabled = [];
  saveProviderSettings(root, config);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped.length, 1);
  assert.throws(() => guard.assert(), /Resume explicitly/);
  await assert.rejects(
    guardProviderWork(root, 'google:pro', () => {}),
    /disabled/
  );
  observeProvider(root, 'google', { quota: { windows: [{ remainingPercent: 80, checkedAt: Date.now() }] } });
  assert.equal(modelAvailability(root, 'google:pro').status, 'disabled');
  assert.equal(stopped.length, 1);
});
test('a provider pause preserves Codex’s confirmed interruption and partial output', async (t) => {
  const root = project(t);
  initializeProviderConfig(root);
  enable(root, 'codex');
  const model = 'gpt-6.2-sol';
  observeProvider(root, 'codex', { ready: true, models: [{ id: model, name: model }] });
  const config = readProviderConfig(root);
  config.providers.codex.enabled = [model];
  t.mock.method(CodexAccountConnection.prototype, 'ready', async () => {});
  t.mock.method(CodexAccountConnection.prototype, 'call', async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    assert.equal(method, 'account/rateLimits/read');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: 70 } } };
  });
  saveProviderSettings(root, config);
  const connection = new CodexConnection({ root });
  const started = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  connection.call = async (method) => {
    if (method === 'turn/start') {
      started.resolve();
      return { turn: { id: 'repair-turn' } };
    }
    assert.equal(method, 'turn/interrupt');
    interrupted.resolve();
    return {};
  };
  t.after(() => connection.close());
  const threadId = 'repair-thread';
  const review = connection.turn(threadId, root, 'Repair Merge', undefined, [], { model });
  await started.promise;
  const rejected = assert.rejects(review, (error) => {
    assert.equal(error.code, 'PROVIDER_PAUSED');
    assert.match(error.message, /Quota is unknown or stale/);
    assert.equal(error.terminalStatus, 'interrupted');
    assert.equal(error.partialText, 'Retained repair progress');
    return true;
  });
  connection.event({
    method: 'item/agentMessage/delta',
    params: { threadId, itemId: 'message', delta: 'Retained repair progress' },
  });
  observeProvider(root, 'codex', { quota: { windows: [{ remainingPercent: 30, checkedAt: Date.now() - 180000 }] } });
  await interrupted.promise;
  connection.event({
    method: 'turn/completed',
    params: { threadId, turn: { id: 'repair-turn', status: 'interrupted' } },
  });
  await rejected;
});

test('disabling a provider clears warnings, blocks new turns and retains an in-flight quota failure', async (t) => {
  const root = project(t);
  initializeProviderConfig(root);
  enable(root, 'codex');
  const model = 'gpt-6.2-sol';
  observeProvider(root, 'codex', { ready: true, models: [{ id: model, name: model }] });
  const config = readProviderConfig(root);
  config.providers.codex.enabled = [model];
  config.providers.codex.warning = 8;
  config.providers.codex.allowUnmonitored = true;
  saveProviderSettings(root, config);
  t.mock.method(CodexAccountConnection.prototype, 'ready', async () => {});
  t.mock.method(CodexAccountConnection.prototype, 'call', async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    assert.equal(method, 'account/rateLimits/read');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: 95 } } };
  });
  const connection = new CodexConnection({ root });
  t.after(() => connection.close());
  const started = Promise.withResolvers();
  const requests = [];
  connection.call = async (method) => {
    requests.push(method);
    started.resolve();
    return { turn: { id: 'original' } };
  };
  const original = connection.turn('thread', root, 'Original request', undefined, [], { model });
  await started.promise;
  assert.equal(modelAvailability(root, model).status, 'warning');
  const enabled = readProviderConfig(root);
  const disabled = changeProviderEnabled(root, { provider: 'codex', active: false, revision: enabled.revision });
  assert.deepEqual(disabled.providers.find((provider) => provider.id === 'codex').models[0].availability, {
    status: 'disabled',
    reason: 'OpenAI is disabled in Factory settings.',
  });
  assert.deepEqual(providerModelChoices(root), []);
  await assert.rejects(connection.turn('later', root, 'New request', undefined, [], { model }), /OpenAI is disabled/);
  const failed = assert.rejects(original, (error) => {
    assert.equal(error.terminalStatus, 'failed');
    assert.match(error.message, /quota exhausted/i);
    return true;
  });
  observeProvider(root, 'codex', { quota: { windows: [{ remainingPercent: 0, checkedAt: Date.now() }] } });
  connection.event({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'original', status: 'failed', error: { message: 'Quota exhausted' } } },
  });
  await failed;
  assert.deepEqual(requests, ['turn/start']);
  assert.equal(modelAvailability(root, model).status, 'disabled');
  const reopened = providerSettings(root);
  assert.equal(reopened.providers.find((provider) => provider.id === 'codex').active, false);
  changeProviderEnabled(root, { provider: 'codex', active: true, revision: reopened.revision });
  assert.deepEqual(readProviderConfig(root).providers.codex, enabled.providers.codex);
  assert.equal(modelAvailability(root, model).status, 'warning');
});

test('quota pauses affect all and only models in their scope and stricter saved thresholds interrupt', async (t) => {
  const root = configured(t),
    stopped = [];
  const config = readProviderConfig(root);
  config.providers.google.enabled.push('google:flash');
  saveProviderSettings(root, config);
  const pro = await guardProviderWork(root, 'google:pro', () => stopped.push('pro'));
  const flash = await guardProviderWork(root, 'google:flash', () => stopped.push('flash'));
  t.after(() => {
    pro.close();
    flash.close();
  });
  observeProvider(root, 'google', {
    quota: {
      windows: [
        { remainingPercent: 30, checkedAt: Date.now() },
        { models: ['google:pro'], remainingPercent: 1, checkedAt: Date.now() },
      ],
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stopped, ['pro']);
  observeProvider(root, 'google', { quota: { windows: [{ remainingPercent: 4, checkedAt: Date.now() }] } });
  assert.equal(modelAvailability(root, 'google:pro').status, 'warning');
  assert.throws(() => pro.assert(), /Resume explicitly/);
  const stricter = readProviderConfig(root);
  stricter.providers.google.disable = 4;
  saveProviderSettings(root, stricter);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stopped, ['pro', 'flash']);
});
test('native discovered model identities preserve exact provider and model', () => {
  assert.deepEqual(agentModel('anthropic:claude-sonnet-4-6'), {
    id: 'anthropic:claude-sonnet-4-6',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    supportsEffort: false,
  });
  assert.throws(() => agentModel('custom:some-model'), /Custom providers/);
});

test('disabled defaults retain their identity and blocking reason without substituting another model', (t) => {
  const root = configured(t);
  writeFileSync(join(root, 'folder.md'), '---\nmodel: google:pro\neffort: medium\n---\n');
  const config = readProviderConfig(root);
  config.providers.google.enabled = [];
  saveProviderSettings(root, config);
  const settings = readModelSettings(root);
  assert.equal(settings.defaults.model, 'google:pro');
  assert.equal(settings.defaultAvailability.status, 'disabled');
  assert.match(settings.defaultAvailability.reason, /disabled/);
  assert.equal(
    settings.models.some((entry) => entry.id === 'google:pro'),
    false
  );
});
test('an incomplete quota event cannot claim complete monitoring', () => {
  const value = quotaAvailability(policy, { complete: false, windows: [window(50)] }, 'anthropic:sonnet', now);
  assert.equal(value.status, 'unknown');
});

test('Claude credits-required rejection blocks the provider even without a utilization or window type', (t) => {
  const root = configured(t);
  enable(root, 'anthropic');
  const models = ['anthropic:sonnet', 'anthropic:opus'];
  observeProvider(root, 'anthropic', { ready: true, models: models.map((id) => ({ id, name: id })) });
  const config = readProviderConfig(root);
  config.providers.anthropic.enabled = models;
  config.providers.anthropic.allowUnmonitored = true;
  saveProviderSettings(root, config);
  const connection = new NativeAgentConnection({ root, model: models[0] });
  connection.observeClaudeQuota({ status: 'rejected', errorCode: 'credits_required' });
  assert.ok(models.every((model) => modelAvailability(root, model).status === 'disabled'));
  assert.equal(modelAvailability(root, 'google:pro').status, 'unmonitored');
});

test('preview provider reads show supported providers without persisting configuration', (t) => {
  const root = project(t);
  const preview = providerSettings(root, { initialize: false });
  assert.equal(preview.readOnly, true);
  assert.deepEqual(
    preview.providers.map((provider) => provider.id),
    ['codex', 'anthropic', 'google']
  );
  assert.equal(readProviderConfig(root), null);
});

test('the same installation shares policy watches when opened through a filesystem alias', async (t) => {
  const root = configured(t),
    alias = join(root, 'alias');
  symlinkSync(root, alias, 'dir');
  let stopped = false;
  const guard = await guardProviderWork(alias, 'google:pro', () => {
    stopped = true;
  });
  t.after(() => guard.close());
  const config = readProviderConfig(root);
  config.providers.google.enabled = [];
  saveProviderSettings(root, config);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped, true);
});

test('Claude utilization preserves the exact warning and disable percentage boundaries', (t) => {
  const root = configured(t),
    model = 'anthropic:sonnet';
  enable(root, 'anthropic');
  observeProvider(root, 'anthropic', { ready: true, models: [{ id: model, name: model }] });
  const config = readProviderConfig(root);
  config.providers.anthropic.enabled = [model];
  config.providers.anthropic.allowUnmonitored = true;
  saveProviderSettings(root, config);
  const connection = new NativeAgentConnection({ root, model });
  connection.observeClaudeQuota({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.95 });
  assert.equal(modelAvailability(root, model).status, 'warning');
  connection.observeClaudeQuota({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.98 });
  assert.equal(modelAvailability(root, model).status, 'disabled');
});
