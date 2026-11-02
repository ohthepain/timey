import { fileURLToPath } from 'node:url';
import { git, requireThat } from './common.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
export function runtimeInfo(service) {
  if (service.runtimeIdentity)
    return {
      ...service.runtimeIdentity,
      sourceChanged: git(source, 'rev-parse', 'HEAD') !== service.runtimeIdentity.revision || sourceDirty(),
    };
  return {
    sourceChanged: sourceDirty(),
    pid: process.pid,
    project: service.root,
    checkout: git(source, 'rev-parse', '--show-toplevel'),
    revision: git(source, 'rev-parse', 'HEAD'),
    branch: git(source, 'branch', '--show-current'),
    mode: service.reviewMode || 'live',
    authoritativeUrl: service.authoritativeUrl || null,
  };
}
function sourceDirty() {
  return Boolean(git(source, 'status', '--porcelain', '--untracked-files=all'));
}
export async function readRuntime(address, observe = () => {}, site = false, requestOptions = {}) {
  const url = new URL(address);
  const timeoutMs = requestOptions.timeoutMs ?? 10000;
  const fetchOptions = { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
  requireThat(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
    'Use a local factory URL.'
  );
  let cookie = requestOptions.cookie;
  if (!cookie || site) {
    const page = await runtimeRequest(url.origin + '/', fetchOptions, 'page', observe);
    requireThat(page.ok, 'The factory page is unavailable.');
    if (site) {
      const html = await page.text();
      requireThat(
        page.headers.get('content-type')?.includes('text/html') && /<div\s+id=["']app["']/.test(html),
        'The factory page did not return the issue interface.'
      );
    }
    cookie = page.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  }
  const response = await runtimeRequest(
    url.origin + '/api/runtime',
    {
      headers: { cookie },
      ...fetchOptions,
    },
    'runtime',
    observe
  );
  requireThat(response.ok, 'This server does not expose runtime identity.');
  const identity = await response.json();
  if (site) await checkQueue(url.origin, cookie, observe, timeoutMs);
  return { ...identity, url: url.origin, sessionCookie: cookie };
}

async function checkQueue(origin, cookie, observe, timeoutMs) {
  const response = await runtimeRequest(
    origin + '/api/queue',
    { headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) },
    'queue',
    observe
  );
  requireThat(response.ok, 'The issue queue is unavailable.');
  const queue = await response.json();
  requireThat(Array.isArray(queue.issues), 'The issue queue returned an invalid response.');
}

async function runtimeRequest(url, options, phase, observe) {
  const path = new URL(url).pathname;
  observe({ phase, path, event: 'request' });
  const response = await fetch(url, options);
  observe({ phase, path, event: 'response', status: response.status, ok: response.ok });
  return response;
}
