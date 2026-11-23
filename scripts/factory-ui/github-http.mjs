import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { finishGitHubCall, startGitHubCall } from './github-call-history.mjs';

const context = new AsyncLocalStorage();
const active = new WeakMap();

const routeParts = new Set(
  'access_tokens actions app artifacts branches check-runs commits compare contents graphql installation installations issues jobs logs merge protection pulls releases repos required_status_checks rules rulesets runs statuses user'.split(
    ' '
  )
);

export function githubCallMetadata(url, method, fallbackRepository = null) {
  const target = URL.parse(url);
  if (target?.hostname !== 'api.github.com') return null;
  const parts = target.pathname.split('/').slice(1);
  const repository = repositoryLabel(parts, fallbackRepository);
  const route = parts.slice(0, 12).map(routeLabel).join('/');
  return { operation: `${method} /${route}`, repository };
}

function repositoryLabel(parts, fallback) {
  const repo = parts[0] === 'repos' ? parts.splice(1, 2).join('/') : fallback;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function routeLabel(part) {
  return routeParts.has(part) || /^\d{1,15}$/.test(part) ? part : '…';
}

export function networkFailure(code) {
  if (/timeout|timed out|deadline exceeded|abort/i.test(code)) return 'Timed out';
  if (/ENOTFOUND|EAI_AGAIN|no such host/i.test(code)) return 'DNS lookup failed';
  return 'Network error';
}

function requestErrorCode(error) {
  return error.cause?.code ?? error.code ?? error.name;
}

export function githubFetch(repository, url, options) {
  return context.run({ repository }, () => fetch(url, options));
}

subscribe('undici:request:create', ({ request }) => {
  const scope = context.getStore();
  if (!scope) return;
  const details = githubCallMetadata(request.origin + request.path, request.method, scope.repository);
  if (details) active.set(request, { id: startGitHubCall(details), start: performance.now(), status: null });
});

subscribe('undici:request:headers', ({ request, response }) => {
  const entry = active.get(request);
  if (entry) entry.status = response.statusCode;
});

function complete(request, failure) {
  const entry = active.get(request);
  if (!entry) return;
  active.delete(request);
  finishGitHubCall(entry.id, {
    durationMs: performance.now() - entry.start,
    status: entry.status,
    failure,
  });
}

subscribe('undici:request:trailers', ({ request }) => complete(request));
subscribe('undici:request:error', ({ request, error }) => complete(request, networkFailure(requestErrorCode(error))));
