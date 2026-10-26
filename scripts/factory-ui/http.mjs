import { serverControl } from './server-control.mjs';
import { toggleRoute } from './route-toggle.mjs';
import { createServer } from 'node:http';
import { runtimeInfo } from './runtime.mjs';
import { queueResponse } from './queue-response.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { requireThat } from './common.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    requireThat(Buffer.byteLength(text) < 65536, 'Request too large.');
  }
  return JSON.parse(text || '{}');
}
function authenticated(request, token, port) {
  return (request.headers.cookie || '').split(';').some((value) => value.trim() === `timey_factory_${port}=${token}`);
}
function authorize(request, token, port) {
  requireThat(request.headers.host === `127.0.0.1:${port}`, 'Use the local URL printed by this server.');
  requireThat(authenticated(request, token, port), 'Open the factory page before requesting its data.');
  if (request.method === 'POST') {
    requireThat(
      request.headers.origin === `http://127.0.0.1:${port}`,
      'This operation must come from the local factory page.'
    );
    requireThat(
      request.headers['x-factory-action'] === 'manual' && request.headers['content-type'] === 'application/json',
      'Explicit JSON actions are required.'
    );
  }
}
async function mutation(service, path, value, owner) {
  requireLiveMutation(service, path);
  service.serverControl?.allow(path, value);
  const discussionRoutes = {
    '/api/site-review-open': () => service.siteReviews.open(value, owner),
    '/api/site-review-decide': () => service.siteReviews.decide(value, owner),
    '/api/discussion-open': () => service.discussions.open(value, owner),
    '/api/discussion-turn': () => service.discussions.turn(value, owner),
    '/api/discussion-summary': () => service.discussions.summarize(value, owner),
    '/api/discussion-prepare': () => service.discussions.prepare(value, owner),
    '/api/discussion-commit': () => service.discussions.commit(value, owner),
    '/api/discussion-end': () => service.discussions.end(value, owner),
  };
  if (path.startsWith('/api/site-review-')) {
    requireThat(Object.hasOwn(discussionRoutes, path), 'Unknown site review operation.');
    return discussionRoutes[path]();
  }
  if (Object.hasOwn(discussionRoutes, path)) return temporaryAction(discussionRoutes[path]);
  const routes = {
    '/api/server-restart': () => service.serverControl.request(),
    '/api/server-cancel-restart': () => service.serverControl.cancel(),
    '/api/lifecycle-start': () => service.startLifecycle(value),
    '/api/lifecycle-answer': () => service.answerLifecycle(value),
    '/api/lifecycle-pause': () => service.pauseLifecycle(value),
    '/api/approve-review-file': () => service.approveReviewFile(value),
    '/api/toggle-route': () => toggleRoute(service, value),
    '/api/skip-plan-checks': () => service.skipPlanChecks(value),
    '/api/check-implementation': () => service.checkImplementation(value.issueId, value.state, value.path, value.basis),
    '/api/plan-decision': () =>
      service.decidePlanCheck(value.issueId, value.state, value.checkId, value.status, value.basis, value.result),
    '/api/find-worker': () => service.findConnection(value.issueId, value.state, value.basis),
    '/api/connect-worker': () => service.connectWorker(value.issueId, value.state, value.basis, value.link),
    '/api/issue-decision': () => service.decideIssue(value.issueId, value.state, value.kind, value.basis, value.reason),
    '/api/check-readiness': () => service.checkReadiness(value.issueId, value.state),
    '/api/progress-preflight': () => service.progressPreflight(value.issueId, value.state),
    '/api/progress-start': () => service.progressStart(value.token, value.humanApproved),
    '/api/evaluate': () => service.evaluate(value.basis),
    '/api/save-review': () => service.saveReview(value.runId, value.basis),
    '/api/preflight': () => service.preflight(value.actionId, value.kind),
    '/api/start': () => service.start(value.token, value.humanApproved),
    '/api/resume': () => service.resume(value.runId, value.text),
    '/api/answer': () => service.answer(value.runId, value.requestId, value.response),
  };
  if (Object.hasOwn(routes, path)) return routes[path]();
  throw Error('Unknown operation. No action was taken.');
}
export function createFactoryServer(service, options = {}) {
  service.serverControl = serverControl(service, options.restart);
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    try {
      requireThat(request.headers.host === `127.0.0.1:${server.address().port}`, 'Use the local factory address.');
      await respond(service, request, response, token, server.address().port);
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.once('close', () => service.serverControl.close());
  return server;
}

async function respond(service, request, response, token, port) {
  if (isPage(request)) return page(response, token, port);
  authorize(request, token, port);
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET') return readResource(service, request, response, token);
  if (request.method === 'POST')
    return response.end(JSON.stringify(await mutation(service, request.url, await body(request), token)));
  response.statusCode = 405;
  response.end(JSON.stringify({ error: 'Unsupported method' }));
}
function page(response, token, port) {
  response.setHeader('Set-Cookie', `timey_factory_${port}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(readFileSync(join(directory, 'index.html')));
}
function read(service, request, response, owner) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const routes = {
    '/api/runtime': () => ({ ...runtimeInfo(service), server: service.serverControl.status() }),
    '/api/server-status': () => service.serverControl.status(),
    '/api/document': () => service.readPlan(url.searchParams.get('path')),
    '/api/check-evidence': () =>
      service.readChecklistEvidence(url.searchParams.get('issue'), url.searchParams.get('path')),
    '/api/queue': () => queueResponse(service.snapshot(owner), url.searchParams.get('issue')),
    '/api/run': () => savedRun(service, url.searchParams.get('id')),
  };
  if (Object.hasOwn(routes, url.pathname)) return response.end(JSON.stringify(routes[url.pathname]()));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Not found' }));
}

function isPage(request) {
  return request.method === 'GET' && request.url === '/';
}

async function temporaryAction(action) {
  try {
    return await action();
  } catch {
    throw Error('Discussion could not complete. Refresh or start a new temporary discussion.');
  }
}

function readResource(service, request, response, owner) {
  const scripts = {
    '/server-control-ui.js': new URL('./server-control-ui.js', import.meta.url),
    '/queue-lifecycle-ui.js': new URL('./queue-lifecycle-ui.js', import.meta.url),
    '/site-review-ui.js': new URL('./site-review-ui.js', import.meta.url),
    '/discussion-ui.js': new URL('./discussion-ui.js', import.meta.url),
  };
  if (Object.hasOwn(scripts, request.url)) {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return response.end(readFileSync(scripts[request.url]));
  }
  return read(service, request, response, owner);
}

function savedRun(service, id) {
  const run = service.store.list(service.codex.requests).find((item) => item.id === id);
  requireThat(run, 'This saved run no longer exists.');
  return run;
}

function requireLiveMutation(service, path) {
  if (service.reviewMode === 'preview')
    requireThat(
      [
        '/api/discussion-open',
        '/api/discussion-turn',
        '/api/discussion-prepare',
        '/api/discussion-summary',
        '/api/discussion-end',
      ].includes(path),
      'This is a preview copy. Make changes and record approvals on the real issue.'
    );
}
