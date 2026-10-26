import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { git, requireThat, writeJson } from './factory-ui/common.mjs';
import { validateSummary } from './factory-ui/checks.mjs';
import { deploymentSession, startFactory, waitFor, portReleased, readyRuntime } from './factory-deploy-transport.mjs';

function candidate(options) {
  const checkout = realpathSync(options.checkout),
    project = realpathSync(options.project);
  requireThat(!git(checkout, 'status', '--porcelain'), 'Commit and verify the candidate before deploying.');
  const revision = git(checkout, 'rev-parse', 'HEAD'),
    tree = git(checkout, 'rev-parse', 'HEAD^{tree}');
  const summary = JSON.parse(readFileSync(options.verification, 'utf8'));
  requireThat(summary.checkpoint === 'verification', 'Use a full verification summary.');
  validateSummary(summary, git(checkout, 'rev-parse', options.base + '^{commit}'), tree);
  requireThat(existsSync(join(checkout, 'scripts/factory-ui.mjs')), 'Candidate is missing the factory UI.');
  return { checkout, project, revision, tree };
}
function requireRecoverable(runtime, project) {
  requireThat(runtime.mode === 'live' && runtime.project === project, 'Select the live factory for this project.');
  requireThat(!runtime.sourceChanged, 'The running source changed. Reconcile before deployment.');
  requireThat(
    Number.isInteger(runtime.pid) && runtime.pid > 1,
    'Restart this older server manually once to enable managed deployment.'
  );
  requireThat(git(runtime.checkout, 'rev-parse', 'HEAD') === runtime.revision, 'Recovery checkout changed.');
  requireThat(!git(runtime.checkout, 'status', '--porcelain'), 'Recovery checkout has uncommitted work.');
}
export async function deployFactory(options) {
  const target = candidate(options),
    session = await deploymentSession(options.url);
  requireRecoverable(session.runtime, target.project);
  const directory = join(target.project, '.issues/evidence');
  mkdirSync(directory, { recursive: true });
  const lock = join(target.project, '.issues/factory-deploy.lock');
  mkdirSync(lock);
  const receipt = {
    operationId: randomUUID(),
    target,
    previous: session.runtime,
    verification: options.verification,
    base: options.base,
    status: 'prepared',
  };
  const path = join(directory, 'deployment-' + receipt.operationId + '.json');
  writeJson(join(lock, 'owner.json'), { pid: process.pid, receipt: path });
  try {
    await activate(session, target, receipt, path);
    return { ...receipt, receipt: path };
  } finally {
    writeJson(path, receipt);
    if (receipt.recovery?.status !== 'failed') rmSync(lock, { recursive: true });
  }
}
async function activate(session, target, receipt, path) {
  const previous = session.runtime,
    port = Number(new URL(previous.url).port);
  let stopped = false,
    child;
  try {
    const drained = await session.action('prepare');
    requireThat(
      drained.pid === previous.pid && drained.revision === previous.revision,
      'The server changed during deployment.'
    );
    requireRecoverable(drained, target.project);
    writeJson(path, receipt);
    candidate({ ...target, verification: receipt.verification, base: receipt.base });
    process.kill(previous.pid, 'SIGTERM');
    stopped = true;
    await waitFor(() => portReleased(port), 'the old listener to release its port');
    child = startFactory(target.checkout, target.project, port, path + '.log');
    child.on('error', () => {}); // Readiness reports spawn and early-exit failures through the retained log.
    await waitFor(
      () => readyRuntime(previous.url, target.checkout, target.revision, target.project),
      'the verified candidate'
    );
    receipt.status = 'ready';
    receipt.pid = child.pid;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error.message;
    await recoverOrCancel(stopped, session, previous, port, child, receipt, path);
    throw Error(error.message + ' Deployment receipt: ' + path);
  }
}
async function recover(previous, port, child, receipt, path) {
  if (child?.pid && child.exitCode === null) child.kill('SIGTERM');
  await waitFor(() => portReleased(port), 'the failed candidate to release its port');
  const restored = startFactory(previous.checkout, previous.project, port, path + '.log');
  restored.on('error', () => {});
  await waitFor(
    () => readyRuntime(previous.url, previous.checkout, previous.revision, previous.project),
    'the previous server'
  );
  receipt.recovery = { status: 'ready', pid: restored.pid };
}
function options() {
  const args = process.argv.slice(2),
    value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ['--checkout', '--project', '--url', '--verification', '--base'])
    requireThat(
      args.includes(flag) && value(flag),
      'Required: --checkout PATH --project PATH --url URL --verification SUMMARY --base COMMIT'
    );
  return {
    checkout: value('--checkout'),
    project: value('--project'),
    url: value('--url'),
    verification: value('--verification'),
    base: value('--base'),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await deployFactory(options()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function recoverOrCancel(stopped, session, previous, port, child, receipt, path) {
  if (!stopped) return session.action('cancel').catch(() => {});
  try {
    await recover(previous, port, child, receipt, path);
  } catch (error) {
    receipt.recovery = { status: 'failed', error: error.message };
  }
}
