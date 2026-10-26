import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { readRuntime } from './factory-ui/runtime.mjs';
import { cleanEnvironment, requireThat } from './factory-ui/common.mjs';

export async function deploymentSession(address) {
  const runtime = await readRuntime(address),
    origin = runtime.url;
  const page = await fetch(origin + '/', { redirect: 'error' });
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  return {
    runtime,
    async action(name) {
      const response = await fetch(origin + '/api/deployment-' + name, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json', 'x-factory-action': 'manual' },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const value = await response.json();
      requireThat(response.ok, value.error || 'Deployment request failed.');
      return value;
    },
  };
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
export async function readyRuntime(url, checkout, revision, project) {
  try {
    const runtime = await readRuntime(url);
    return sameIdentity(runtime, { checkout, revision, project, mode: 'live', sourceChanged: false });
  } catch {
    return false;
  }
}

function sameIdentity(runtime, expected) {
  return Object.entries(expected).every(([key, value]) => runtime[key] === value);
}
