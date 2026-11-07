import { mkdirSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { git, requireThat, writeJson } from './factory-ui/common.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';
import { deploymentSession, startFactory, portReleased } from './factory-deploy-transport.mjs';
import { observeRuntime } from './factory-deploy-readiness.mjs';

function candidate(options) {
  const checkout = realpathSync(options.checkout || process.cwd());
  const revision = git(checkout, 'rev-parse', 'HEAD'),
    tree = git(checkout, 'rev-parse', 'HEAD^{tree}'),
    sourceChanged = Boolean(git(checkout, 'status', '--porcelain', '--untracked-files=all'));
  requireThat(existsSync(join(checkout, 'scripts/factory-ui.mjs')), 'The selected checkout has no factory server.');
  return {
    checkout,
    revision,
    tree,
    sourceChanged,
    verification: options.verification ? resolve(options.verification) : null,
  };
}
async function until(check, description, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for ' + description + '.');
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
export async function restartFactory(options = {}) {
  const target = candidate(options),
    project = realpathSync(options.project || process.cwd());
  const timeout = options.timeout ?? 30000,
    requestTimeout = options.requestTimeout ?? 120000,
    progress = options.progress || console.log;
  const session = await deploymentSession(options.url || 'http://127.0.0.1:52995', { timeoutMs: requestTimeout });
  const previous = session.runtime;
  requireThat(previous.mode === 'live' && previous.project === project, 'Select the live factory for this project.');
  requireThat(
    Number.isInteger(previous.pid) && previous.pid > 1 && previous.pid !== process.pid,
    'The server did not provide a safe process identity.'
  );
  mkdirSync(join(project, '.issues/evidence'), { recursive: true });
  const lock = join(project, '.issues/factory-deploy.lock');
  mkdirSync(lock);
  const path = join(project, '.issues/evidence', 'restart-' + randomUUID() + '.json');
  const receipt = { operation: 'restart-factory', previous, target, status: 'preparing', log: path + '.log' };
  let prepared = false,
    stopped = false,
    stopRequested = false,
    child;
  try {
    writeJson(join(lock, 'owner.json'), { pid: process.pid, receipt: path });
    writeJson(path, receipt);
    progress('Pausing new actions; waiting for current work and approvals to finish…');
    if (previous.server?.phase === 'idle') await session.request('/api/server-pause');
    await until(
      async () => {
        const current = await readRuntime(previous.url, () => {}, false, {
          cookie: session.cookie,
          timeoutMs: requestTimeout,
        });
        requireThat(
          current.pid === previous.pid && current.project === project,
          'The running server changed; no process was stopped.'
        );
        const state = current.server;
        requireThat(
          state?.phase !== 'restarting' && !(state?.phase === 'draining' && !state.error),
          'Another server restart is already in progress; no process was stopped.'
        );
        if (!state || state.actions || state.chats || state.approvals || state.locks?.length) return false;
        try {
          await session.action('prepare');
          prepared = true;
          return true;
        } catch (error) {
          if (/^Wait for |^Pause lifecycle Progress/.test(error.message)) return false;
          throw error;
        }
      },
      'the server to drain (work stays saved and paused; no process was stopped)',
      timeout
    );
    const owner = JSON.parse(readFileSync(join(project, '.issues/factory-ui-server.lock/owner.json'), 'utf8'));
    requireThat(owner.pid === previous.pid, 'The server ownership changed; no process was stopped.');
    const fresh = candidate(options);
    requireThat(
      fresh.revision === target.revision && fresh.tree === target.tree,
      'The selected candidate changed during draining.'
    );
    progress('Stopping PID ' + previous.pid + '…');
    process.kill(previous.pid, 'SIGTERM');
    stopRequested = true;
    await until(
      async () => !alive(previous.pid) && (await portReleased(Number(new URL(previous.url).port))),
      'the old process and listener to exit',
      timeout
    );
    stopped = true;
    progress('Starting ' + target.revision.slice(0, 8) + ' from ' + target.checkout + '…');
    child = startFactory(target.checkout, project, Number(new URL(previous.url).port), receipt.log);
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    await until(
      async () => {
        requireThat(!spawnError && child.exitCode === null, 'The replacement server exited. See ' + receipt.log);
        const observed = await observeRuntime(
          previous.url,
          {
            checkout: target.checkout,
            project,
            revision: target.revision,
            pid: child.pid,
            mode: 'live',
            sourceChanged: target.sourceChanged,
          },
          { timeoutMs: requestTimeout }
        );
        receipt.readiness = observed;
        return observed.outcome === 'ready';
      },
      'the replacement HTML, queue, PID and revision to be ready',
      timeout
    );
    receipt.status = 'ready';
    receipt.pid = child.pid;
    progress(`Ready: ${previous.url} · PID ${child.pid} · ${target.revision.slice(0, 8)}`);
    return { ...receipt, receipt: path };
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error.message;
    receipt.previousStopRequested = stopRequested;
    receipt.previousStopped = stopped;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (prepared && !stopRequested) await session.action('cancel').catch(() => {});
    throw Error(error.message + ' Restart receipt: ' + path + ' Server log: ' + receipt.log);
  } finally {
    writeJson(path, receipt);
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (owner.pid === process.pid && owner.receipt === path) rmSync(lock, { recursive: true });
  }
}
function argumentsForCLI(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--') continue;
    if (key === '--help') return null;
    requireThat(
      ['--checkout', '--project', '--url', '--verification', '--timeout', '--request-timeout'].includes(key) &&
        args[i + 1] &&
        !args[i + 1].startsWith('--'),
      'Unknown or incomplete option: ' + key
    );
    const flag = key.slice(2);
    const value = flag === 'timeout' || flag === 'request-timeout' ? Number(args[++i]) : args[++i];
    if (flag === 'request-timeout') options.requestTimeout = value;
    else options[flag] = value;
  }
  for (const name of ['timeout', 'requestTimeout']) {
    requireThat(
      options[name] === undefined || (Number.isFinite(options[name]) && options[name] > 0),
      'Use a positive timeout in milliseconds for --' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + '.'
    );
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsForCLI(process.argv.slice(2));
    if (options) await restartFactory(options);
    else
      console.log(
        'pnpm factory:restart [--checkout PATH] [--project PATH] [--url http://127.0.0.1:52995] [--verification PATH] [--timeout MS] [--request-timeout MS]\nUses saved full verification; never runs tests, pulls, merges, or force-kills work. Paused issue work remains saved for explicit continuation. --request-timeout defaults to 120000 for slow local servers.'
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
