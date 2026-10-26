import { fileURLToPath } from 'node:url';
import { git, requireThat } from './common.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
export function runtimeInfo(service) {
  if (service.runtimeIdentity)
    return {
      ...service.runtimeIdentity,
      sourceChanged: git(source, 'rev-parse', 'HEAD') !== service.runtimeIdentity.revision,
    };
  return {
    pid: process.pid,
    project: service.root,
    checkout: git(source, 'rev-parse', '--show-toplevel'),
    revision: git(source, 'rev-parse', 'HEAD'),
    branch: git(source, 'branch', '--show-current'),
    mode: service.reviewMode || 'live',
    authoritativeUrl: service.authoritativeUrl || null,
  };
}
export async function readRuntime(address) {
  const url = new URL(address);
  requireThat(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
    'Use a local factory URL.'
  );
  const page = await fetch(url.origin + '/', { signal: AbortSignal.timeout(10000), redirect: 'error' });
  requireThat(page.ok, 'The factory page is unavailable.');
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await fetch(url.origin + '/api/runtime', {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  requireThat(response.ok, 'This server does not expose runtime identity.');
  return { ...(await response.json()), url: url.origin };
}
