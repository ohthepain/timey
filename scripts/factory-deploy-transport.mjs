import { observeRuntime } from './factory-deploy-readiness.mjs';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { readRuntime } from './factory-ui/runtime.mjs';
import { cleanEnvironment, requireThat } from './factory-ui/common.mjs';

export async function deploymentSession(address, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const runtime = await readRuntime(address, () => {}, false, { timeoutMs });
  const origin = runtime.url;
  const cookie = runtime.sessionCookie;
  async function request(path) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-factory-action': 'manual' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = await response.json();
    requireThat(response.ok, value.error || 'Deployment request failed.');
    return value;
  }
  return { runtime, request, action: (name) => request('/api/deployment-' + name), cookie };
}
export function startFactory(checkout, project, port, log) {
  const fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [join(checkout, 'scripts/factory-ui.mjs'), '--project', project, '--port', String(port)],
      { cwd: checkout, env: cleanEnvironment(), detached: true, stdio: ['ignore', fd, fd] }
    );
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}
export async function waitFor(predicate, description, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for ' + description + '. Inspect the deployment receipt and server log.');
}
export function portReleased(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
export async function readyRuntime(url, checkout, revision, project, record = () => {}) {
  const observation = await observeRuntime(url, { checkout, revision, project, mode: 'live', sourceChanged: false });
  record(observation);
  return observation.outcome === 'ready';
}
