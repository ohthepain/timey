import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { sign } from 'node:crypto';
import { requireThat } from './common.mjs';

// Only paths and public IDs live on disk. Installation tokens stay in memory.
export class GitHubAppCredentials {
  constructor(config, repository, { request = fetch, now = Date.now } = {}) {
    requireThat(Number.isSafeInteger(config.appId) && config.appId > 0, 'Invalid GitHub App ID.');
    requireThat(isAbsolute(config.privateKeyPath || ''), 'GitHub App key path must be absolute.');
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
    } catch {
      throw Error('GitHub App authentication request failed.');
    }
    requireThat(response.ok, `GitHub App authentication failed (HTTP ${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw Error('Invalid GitHub App authentication response.');
    }
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
        sign('RSA-SHA256', Buffer.from(payload), readFileSync(this.config.privateKeyPath)).toString('base64url');
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
    const token = await this.api(`app/installations/${installation.id}/access_tokens`, jwt, {
      repositories: [this.repository.split('/')[1]],
    });
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

export function githubAppCredentials(root, repository) {
  const path = join(root, '.issues/github-app.json');
  return existsSync(path) ? new GitHubAppCredentials(JSON.parse(readFileSync(path, 'utf8')), repository) : null;
}
