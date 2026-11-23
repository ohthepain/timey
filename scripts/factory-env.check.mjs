import { generateKeyPairSync } from 'node:crypto';
import { setupFactoryEnv } from './factory-setup.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubAppCredentials } from './factory-ui/github-app.mjs';
import { githubAppEnvironmentKeys } from './factory-ui/project-env.mjs';

beforeEach((t) => {
  for (const key of githubAppEnvironmentKeys) {
    const original = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
});

test('factory credentials load from the owning project .env without being exported', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, '.env'),
    'TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID=123\nTIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID=456\nTIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY="test-key\\nsecond-line"\n'
  );
  const credentials = githubAppCredentials(root, 'fixture/repo');
  assert.ok(credentials);
  assert.equal(credentials.config.appId, 123);
  assert.equal(credentials.config.installationId, 456);
  assert.equal(credentials.config.privateKey, 'test-key\nsecond-line');
  assert.equal(process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID, undefined);
});

test('exported credentials override project values without changing process.env', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-env-precedence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = 'TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID';
  process.env[name] = '999';
  writeFileSync(
    join(root, '.env'),
    'TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID=123\nTIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID=456\nTIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY=test-key\n'
  );
  assert.equal(githubAppCredentials(root, 'fixture/repo').config.appId, 999);
  assert.equal(process.env[name], '999');
});

test('setup preserves existing .env contents and is idempotent with a multiline PEM', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const original = '# Existing settings\nOTHER_SETTING=keep-me\nTIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID=123\n';
  writeFileSync(join(root, '.env'), original);
  assert.equal(setupFactoryEnv(root, { appId: '999', installationId: '456', privateKey }).added, 2);
  const configured = readFileSync(join(root, '.env'), 'utf8');
  assert.ok(configured.startsWith(original));
  assert.equal(githubAppCredentials(root, 'fixture/repo').config.privateKey, privateKey);
  assert.equal(githubAppCredentials(root, 'fixture/repo').config.appId, 123);
  assert.equal(setupFactoryEnv(root).added, 0);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), configured);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.env\n');
});

test('invalid setup never writes a partial credential file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-setup-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'UNCHANGED=yes\n');
  assert.throws(
    () => setupFactoryEnv(root, { appId: '123', installationId: '456', privateKey: 'invalid' }),
    /valid GitHub App PEM/
  );
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'UNCHANGED=yes\n');
});

test('providers share authentication requests until credentials change', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-auth-reuse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  setupFactoryEnv(root, { appId: '123', installationId: '456', privateKey });
  let calls = 0,
    installationId = 456;
  const request = async (url) => {
    calls++;
    const body = url.endsWith('/app')
      ? { id: 123, slug: 'fixture' }
      : url.endsWith('/installation')
        ? { id: installationId, app_id: 123 }
        : { token: 'fixture-token-' + installationId, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    return { ok: true, json: async () => body };
  };
  githubAppCredentials(root, 'fixture/repo').request = request;
  const [first, second] = await Promise.all([
    githubAppCredentials(root, 'fixture/repo').session(),
    githubAppCredentials(root, 'fixture/repo').session(),
  ]);
  assert.equal(first.token, 'fixture-token-456');
  assert.equal(second.token, first.token);
  assert.equal(calls, 3, 'Concurrent providers repeated authentication.');
  await githubAppCredentials(root, 'fixture/repo').session();
  assert.equal(calls, 3, 'A valid token was minted again.');
  installationId = 457;
  const path = join(root, '.env');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/INSTALL_ID="?456"?/, 'INSTALL_ID=457'));
  githubAppCredentials(root, 'fixture/repo').request = request;
  assert.equal((await githubAppCredentials(root, 'fixture/repo').session()).token, 'fixture-token-457');
  assert.equal(calls, 6, 'Changed credentials reused the old token.');
});
