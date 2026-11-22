import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectSettingsOverview, changeProjectSettings } from './factory-ui/project-settings-overview.mjs';
import { changeFolderSettings } from './factory-ui/folder-settings-routes.mjs';
import { githubAppEnvironmentKeys } from './factory-ui/project-env.mjs';

function fixture(t, shared = false) {
  const environment = Object.fromEntries(githubAppEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of githubAppEnvironmentKeys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = mkdtempSync(join(tmpdir(), 'project-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.issues'));
  const config = {
    custom: 'preserved',
    sharedIssueQueue: shared,
    sharedIssueQueueBranch: 'queue',
    sharedIssueQueueDirect: false,
    sharedIssueQueueReviewRequired: true,
  };
  writeFileSync(join(root, 'factory.config.json'), JSON.stringify(config));
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository: 'example/project', remote: 'origin', target: 'main' })
  );
  return { root, ownServer() {} };
}

test('Settings reads effective lifecycle labels and the real human-input adapter without changing configuration', (t) => {
  const service = fixture(t);
  const before = readFileSync(join(service.root, 'factory.config.json'), 'utf8');
  const initial = readProjectSettingsOverview(service);
  assert.equal(initial.lifecycle.overrideExists, false);
  assert.equal(initial.lifecycle.effectiveSource, '@timey/local-issues/triage-labels.md');
  writeFileSync(join(service.root, '.issues/triage-labels.md'), initial.lifecycle.content);
  const view = readProjectSettingsOverview(service);
  assert.equal(view.lifecycle.overridePath, '.issues/triage-labels.md');
  assert.equal(view.lifecycle.overrideExists, true);
  assert.ok(view.lifecycle.labels.some(({ role }) => role === 'closed'));
  assert.ok(view.lifecycle.labels.every(({ source }) => source === '.issues/triage-labels.md'));
  assert.equal(view.humanInputPolicy.require_explicit_acceptance, true);
  assert.equal(view.humanInputPolicy.manual_checks_before_commit, false);
  assert.ok(view.humanInputSource.endsWith('/scripts/factory-ui/guard.mjs'));
  assert.equal(readFileSync(join(service.root, 'factory.config.json'), 'utf8'), before);
});

test('Settings projects secret references and availability without returning private material', (t) => {
  const service = fixture(t);
  writeFileSync(
    join(service.root, '.issues/github-app.json'),
    JSON.stringify({ appId: 42, installationId: 21, privateKey: 'private-secret-value', repository: 'example/project' })
  );
  const view = readProjectSettingsOverview(service);
  assert.equal(view.git.configured, true);
  assert.ok(view.git.references.some(({ name, available }) => name.endsWith('#privateKey') && available));
  assert.ok(!JSON.stringify(view).includes('private-secret-value'));
  assert.deepEqual(view.storage.providers, ['local', 'github']);
});

test('Storage saves only supported ordinary options and preserves issue reports and unrelated configuration', (t) => {
  const service = fixture(t, true);
  const report = '---\nid: issue-one\n---\nAn issue that must remain in place.\n';
  writeFileSync(join(service.root, '.issues/issue-one.md'), report);
  const original = readProjectSettingsOverview(service).storage;
  assert.throws(
    () =>
      changeProjectSettings(service, {
        action: 'save-storage',
        revision: original.revision,
        changes: { provider: 'postgresql' },
      }),
    /read-only/
  );
  assert.throws(
    () =>
      changeProjectSettings(service, {
        action: 'save-storage',
        revision: original.revision,
        changes: { sharedIssueQueueDirect: 'yes' },
      }),
    /true or false/
  );
  const saved = changeProjectSettings(service, {
    action: 'save-storage',
    revision: original.revision,
    changes: { sharedIssueQueueDirect: true },
  });
  assert.equal(saved.configuration.sharedIssueQueueDirect, true);
  assert.equal(JSON.parse(readFileSync(join(service.root, 'factory.config.json'))).custom, 'preserved');
  assert.equal(readFileSync(join(service.root, '.issues/issue-one.md'), 'utf8'), report);
  assert.equal(saved.provider, 'github');
  assert.throws(
    () =>
      changeProjectSettings(service, {
        action: 'save-storage',
        revision: original.revision,
        changes: { sharedIssueQueueDirect: false },
      }),
    /changed/
  );
});

test('Local storage connection test checks existing read/write access without changing reports', async (t) => {
  const service = fixture(t);
  const result = await changeProjectSettings(service, { action: 'test-storage' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.permissions, { read: true, write: true });
  assert.equal(result.authenticated, null);
});

test('Git connection tests report authentication and required permissions without leaking token values', async (t) => {
  const service = fixture(t, true);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(
    join(service.root, '.issues/github-app.json'),
    JSON.stringify({ appId: 42, installationId: 21, privateKey, repository: 'example/project' })
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let granted = { contents: 'write', pull_requests: 'write' };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body =
      path === '/app'
        ? { id: 42, slug: 'factory-app' }
        : path.endsWith('/installation')
          ? { id: 21, app_id: 42, permissions: granted }
          : path.endsWith('/access_tokens')
            ? {
                token: 'token-secret-value',
                expires_at: new Date(Date.now() + 3600000).toISOString(),
                permissions: granted,
              }
            : { permissions: { push: true } };
    return { ok: true, json: async () => body };
  };
  const passed = await changeProjectSettings(service, { action: 'test-git' });
  assert.equal(passed.ok, true);
  assert.equal(passed.authenticated, true);
  assert.deepEqual(passed.permissions, granted);
  assert.ok(!JSON.stringify(passed).includes('token-secret-value'));
  granted = { contents: 'read', pull_requests: 'read' };
  const denied = await changeProjectSettings(service, { action: 'test-storage' });
  assert.equal(denied.authenticated, true);
  assert.equal(denied.ok, false);
  globalThis.fetch = async () => {
    throw Error('token-secret-value');
  };
  const failed = await changeProjectSettings(service, { action: 'test-git' });
  assert.equal(failed.authenticated, false);
  assert.ok(!JSON.stringify(failed).includes('token-secret-value'));
});

test('Settings remains readable when a shared queue has incomplete installation configuration', (t) => {
  const service = fixture(t, true);
  writeFileSync(join(service.root, '.issues/issue-delivery-config.json'), '{}');
  const view = readProjectSettingsOverview(service);
  assert.equal(view.storage.provider, 'github');
  assert.match(view.storage.status, /incomplete/);
  assert.deepEqual(view.storage.editableFields, []);
  assert.equal(view.storage.restartRequired, true);
  assert.equal(view.humanInputPolicy.require_explicit_acceptance, true);
});

test('Creating project defaults initializes the project root through its existing owner', async (t) => {
  const service = fixture(t);
  const result = await changeFolderSettings(service, { project: true, action: 'create' });
  assert.equal(result.kind, 'project');
  assert.ok(readFileSync(join(service.root, 'folder.md'), 'utf8').includes('selection_strategy'));
});
