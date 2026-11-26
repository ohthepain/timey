import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanEnvironment, digest, readJson, requireThat, writeJson } from './common.mjs';
import { createDiscussionRuntime } from './discussion-codex.mjs';

const empty = { command: '', url: '', directory: '', expected: '', checkUrl: '' };
const keys = Object.keys(empty);

function appUrl(value) {
  const url = URL.parse(value);
  requireThat(url && ['http:', 'https:'].includes(url.protocol), 'Enter an HTTP or HTTPS app URL.');
  requireThat(!hasCredentials(url), 'Remove credentials from the App URL.');
  return url;
}

function hasCredentials(url) {
  return url.username || url.password;
}

function workingDirectory(root, directory) {
  requireThat(!isAbsolute(directory), 'Enter a working directory relative to the project root.');
  const cwd = realpathSync(resolve(root, directory));
  const path = relative(root, cwd);
  requireThat(
    path !== '..' && !path.startsWith('..' + sep) && statSync(cwd).isDirectory(),
    'Choose a directory inside the project.'
  );
  return cwd;
}

function normalized(input) {
  return Object.fromEntries(
    keys.map((key) => {
      const value = input[key];
      requireThat(
        typeof value === 'string' && value.length <= 4000,
        'Enter launch settings of up to 4,000 characters per field.'
      );
      return [key, value.trim()];
    })
  );
}

function defaultSettings(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return empty;
  const manifest = readJson(file);
  if (manifest.name !== 'tanstack-start-example-basic' || !existsSync(join(root, 'src/lib/BeatRecorder.ts')))
    return empty;
  return { ...empty, command: 'pnpm run dev', url: 'http://localhost:3000' };
}

async function matchesResponse(body, expected) {
  const reader = body.getReader();
  try {
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < 524288) {
      const { done, value } = await reader.read();
      if (done) return false;
      text += decoder.decode(value, { stream: true });
      if (text.includes(expected)) return true;
    }
    return false;
  } finally {
    await reader.cancel();
  }
}

async function responseReady(response, expected) {
  if (response.ok && expected && response.body) return matchesResponse(response.body, expected);
  await discardResponse(response);
  return ordinaryResponseReady(response, expected);
}

async function discardResponse(response) {
  await response.body?.cancel();
}

function ordinaryResponseReady(response, expected) {
  return response.ok && expected === '';
}

async function readiness(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    return { responding: true, ready: await responseReady(response, expected) };
  } catch {
    return { responding: false, ready: false };
  }
}

async function appPortInUse(url, check, existing) {
  if (existing.responding || (await occupied(url))) return true;
  return check.origin !== url.origin && occupied(check);
}

function occupied(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
    const finish = (present) => {
      socket.destroy();
      resolve(present);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

function terminate(processGroup, signal) {
  if (!processGroup.pid) return;
  try {
    process.kill(-processGroup.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    terminate(child, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function detectSettings(root) {
  const runtime = createDiscussionRuntime(undefined, { root });
  const resultFields = [...keys, 'sources', 'undetermined'];
  try {
    await runtime.begin({ task: 'Detect the project’s local development app setup.' });
    const answer = await runtime.ask(
      'Read the project documentation and configuration for its development app. Return command, url, directory relative to the root, expected response text (expected), and checkUrl. A blank directory means project root and a blank checkUrl means use url. Leave unknown fields blank. Explain the source paths in sources, and list unknown fields in undetermined. Do not execute launch commands or write files.',
      [],
      {
        type: 'object',
        properties: Object.fromEntries(resultFields.map((key) => [key, { type: 'string' }])),
        required: resultFields,
        additionalProperties: false,
      }
    );
    return JSON.parse(answer);
  } finally {
    runtime.close();
  }
}

export function createProjectApp(service) {
  const root = service.root;
  const file = join(root, '.issues/factory-ui/project-app.json');
  let processGroup = null;
  let startup = null;
  let startController = null;
  let closed = false;

  function view() {
    const settings = existsSync(file) ? readJson(file) : defaultSettings(root);
    return { settings, revision: digest(JSON.stringify(settings)), managed: Boolean(processGroup) };
  }

  async function action(input) {
    service.ownServer();
    const actions = {
      stop: () => {
        stop();
        return view();
      },
      start,
      detect: detect,
      save: () => save(input),
    };
    requireThat(Object.hasOwn(actions, input.action), 'Choose an app action.');
    return actions[input.action]();
  }

  async function detect() {
    const found = await (service.detectProjectApp || detectSettings)(root);
    return { settings: normalized(found), sources: found.sources, undetermined: found.undetermined };
  }

  function save(input) {
    requireThat(input.revision === view().revision, 'App settings changed. Reopen Settings.');
    const settings = normalized(input.settings || {});
    if (settings.url) appUrl(settings.url);
    if (settings.checkUrl) appUrl(settings.checkUrl);
    workingDirectory(root, settings.directory);
    mkdirSync(dirname(file), { recursive: true });
    writeJson(file, settings);
    return view();
  }

  async function start() {
    requireThat(!closed, 'Factory is shutting down.');
    if (startup) return startup;
    const { settings, revision } = view();
    if (!settings.command || !settings.url) return { missing: true };
    const controller = new AbortController();
    startController = controller;
    startup = launch(settings, revision, controller.signal);
    try {
      return await startup;
    } finally {
      startup = null;
      startController = null;
    }
  }

  async function launch(settings, revision, signal) {
    const url = appUrl(settings.url);
    const check = appUrl(settings.checkUrl || settings.url);
    const existing = await readiness(check, settings.expected);
    signal.throwIfAborted();
    const reused = await reuseApp(settings, revision, url, check, existing);
    if (reused) return reused;
    signal.throwIfAborted();
    const child = spawnApp(settings, revision);
    try {
      await waitForReady(child, check, settings.expected, signal);
      return { url: settings.url, managed: true };
    } catch (error) {
      stop();
      throw error;
    }
  }

  async function reuseApp(settings, revision, url, check, existing) {
    if (processGroup) return managedApp(settings.url, revision, existing.ready);
    if (settings.expected && existing.ready) return { url: settings.url, managed: false };
    requireThat(
      !(await appPortInUse(url, check, existing)),
      'A server occupies the configured port and Factory could not recognize it.'
    );
    return null;
  }

  function managedApp(url, revision, ready) {
    requireThat(processGroup.revision === revision, 'Stop the running app before using the changed setup.');
    requireThat(ready, 'The running app did not pass its readiness check. Stop it to retry.');
    return { url, managed: true };
  }

  function spawnApp(settings, revision) {
    const child = spawn('/bin/sh', ['-c', settings.command], {
      cwd: workingDirectory(root, settings.directory),
      env: cleanEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const app = { child, revision, output: '', error: null };
    processGroup = app;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        app.output = (app.output + data).slice(0, 8000);
      });
    child.on('error', (error) => {
      app.error = error.message;
    });
    child.once('close', (code, signal) => {
      app.error ||= 'App command stopped (' + (signal || code) + ').';
      if (processGroup === app) processGroup = null;
    });
    return app;
  }

  async function waitForReady(app, url, expected, signal) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      requireThat(!app.error, app.error + '\n' + app.output.trim());
      const check = await readiness(url, expected);
      if (check.ready && processGroup === app) return;
      await delay(250, undefined, { signal });
    }
    throw Error('App startup timed out. Check the command and readiness settings.\n' + app.output.trim());
  }

  function stop() {
    startController?.abort(Error('App startup stopped.'));
    const app = processGroup;
    if (!app) return;
    processGroup = null;
    terminate(app.child, 'SIGTERM');
    setTimeout(() => forceStop(app.child), 1500).unref();
  }

  function close() {
    closed = true;
    stop();
  }
  return { view, action, close };
}
