import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { sign } from 'node:crypto';
import { requireThat } from './common.mjs';
import { infrastructureFailure, permissionFailure } from './strategy-repair.mjs';

// Only paths and public IDs live on disk. Installation tokens stay in memory.
export class GitHubAppCredentials {
  constructor(config, repository, { request = fetch, now = Date.now } = {}) {
    requireThat(Number.isSafeInteger(config.appId) && config.appId > 0, 'Invalid GitHub App ID.');
    requireThat(
      typeof config.privateKey === 'string' || isAbsolute(config.privateKeyPath || ''),
      'GitHub App key path must be absolute or private key material must be configured.'
    );
    requireThat(config.repository === repository, 'GitHub App configuration belongs to a different repository.');
    this.config = config;
    this.repository = repository;
    this.request = request;
    this.now = now;
    this.cached = null;
    this.pending = null;
  }
  async api(path, authorization, body) {
    let response;
    try {
      response = await this.request('https://api.github.com/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + authorization,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw authenticationTransportFailure(error, path);
    }
    assertAuthenticationResponse(response);
    return readAuthenticationResponse(response, path);
  }
  async refresh() {
    const seconds = Math.floor(this.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload =
      encode({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      encode({ iat: seconds - 60, exp: seconds + 540, iss: String(this.config.appId) });
    let jwt;
    try {
      jwt =
        payload +
        '.' +
        sign(
          'RSA-SHA256',
          Buffer.from(payload),
          this.config.privateKey || readFileSync(this.config.privateKeyPath)
        ).toString('base64url');
    } catch {
      throw Error('Cannot read or sign with the configured GitHub App private key.');
    }
    const app = await this.api('app', jwt);
    requireThat(app.id === this.config.appId && app.slug, 'GitHub App identity does not match configuration.');
    const installation = await this.api(`repos/${this.repository}/installation`, jwt);
    requireThat(
      installation.app_id === app.id && Number.isSafeInteger(installation.id),
      'Invalid GitHub App installation.'
    );
    requireThat(
      !this.config.installationId || installation.id === this.config.installationId,
      'GitHub App installation does not match configuration.'
    );
    const token = await this.api(
      `app/installations/${this.config.installationId || installation.id}/access_tokens`,
      jwt,
      {
        repositories: [this.repository.split('/')[1]],
      }
    );
    const expires = Date.parse(token.expires_at);
    requireThat(
      typeof token.token === 'string' && token.token && expires > this.now() + 60000,
      'Invalid GitHub App token expiry.'
    );
    this.cached = { token: token.token, expires, appId: app.id, slug: app.slug, installationId: installation.id };
    return this.cached;
  }
  async session() {
    if (this.cached?.expires > this.now() + 60000) return this.cached;
    if (!this.pending)
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

function authenticationTransportFailure(error, path) {
  const cause = error.cause || error;
  const reason = authenticationFailureReason(error);
  const context = authenticationContext(path, reason);
  const failure = Error(`GitHub App authentication request failed${context}.`);
  failure.transient = infrastructureFailure(cause) || Boolean(reason);
  if (permissionFailure(cause)) failure.code = 'EACCES';
  return failure;
}

async function readAuthenticationResponse(response, path) {
  try {
    return await response.json();
  } catch (error) {
    throw authenticationResponseFailure(error, path);
  }
}

function authenticationResponseFailure(error, path) {
  const failure = authenticationTransportFailure(error, path);
  const malformed = error instanceof SyntaxError;
  const reason = malformed ? 'malformed JSON' : authenticationFailureReason(error) || 'unreadable body';
  failure.message = `Invalid GitHub App authentication response (${authenticationStage(path)}; ${reason}).`;
  if (malformed) failure.transient = true;
  return failure;
}

function authenticationContext(path, reason) {
  return reason ? ` (${authenticationStage(path)}; ${reason})` : '';
}

function authenticationStage(path) {
  if (path === 'app') return 'app identity';
  return path.endsWith('/access_tokens') ? 'installation token' : 'installation lookup';
}

// Never copy response bodies, raw exception messages or nested causes: token
// responses contain credentials. Only known transport categories leave this module.
const authenticationReasons = new Map([
  ['TimeoutError', 'timeout'],
  ['AbortError', 'timeout'],
  ['ENOTFOUND', 'DNS lookup failed'],
  ['EAI_AGAIN', 'DNS lookup failed'],
  ['ETIMEDOUT', 'timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
  ['UND_ERR_BODY_TIMEOUT', 'timeout'],
  ['UND_ERR_SOCKET', 'connection interrupted'],
  ['ECONNRESET', 'connection interrupted'],
  ['ECONNABORTED', 'connection interrupted'],
  ['EPIPE', 'connection interrupted'],
]);
function authenticationFailureReason(error) {
  return [error.name, error.cause?.code, error.code].map((code) => authenticationReasons.get(code)).find(Boolean);
}

function assertAuthenticationResponse(response) {
  if (response.ok) return;
  const failure = Error(`GitHub App authentication failed (HTTP ${response.status}).`);
  failure.transient = [429, 500, 502, 503, 504].includes(response.status);
  throw failure;
}

export function githubAppCredentials(root, repository) {
  const appId = process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID;
  const privateKey = process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY;
  const installationId = process.env.TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID;
  if (appId || privateKey || installationId) {
    const parsedAppId = Number(appId);
    const parsedInstallationId = Number(installationId);
    requireThat(Number.isSafeInteger(parsedAppId) && parsedAppId > 0, 'Invalid GitHub App ID environment setting.');
    requireThat(
      typeof privateKey === 'string' && privateKey.trim(),
      'Missing GitHub App private key environment setting.'
    );
    requireThat(
      Number.isSafeInteger(parsedInstallationId) && parsedInstallationId > 0,
      'Invalid GitHub App installation ID environment setting.'
    );
    return new GitHubAppCredentials(
      {
        appId: parsedAppId,
        repository,
        installationId: parsedInstallationId,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      },
      repository
    );
  }
  const path = join(root, '.issues/github-app.json');
  return existsSync(path) ? new GitHubAppCredentials(JSON.parse(readFileSync(path, 'utf8')), repository) : null;
}
