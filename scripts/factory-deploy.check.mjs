import { gitFixture } from './git-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { deployFactory } from './factory-deploy.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';
import { deploymentSession, waitFor, portReleased } from './factory-deploy-transport.mjs';
import { runVerificationProcess } from './verify-process.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function deploymentFixture(t) {
  let serverUrl, initialChild, serverPort;
  t.after(async () => {
    try {
      const runtime = await readRuntime(serverUrl);
      process.kill(runtime.pid, 'SIGTERM');
    } catch {}
    initialChild?.kill('SIGTERM');
    if (serverPort) await waitFor(() => portReleased(serverPort), 'fixture cleanup');
  });
  const f = deliveryFixture(t);
  cpSync(resolve('scripts'), join(f.source.root, 'scripts'), { recursive: true });
  writeFileSync(join(f.source.root, '.gitignore'), '.issues/\nnode_modules\n');
  writeFileSync(join(f.source.root, 'package.json'), '{"type":"module"}\n');
  symlinkSync(resolve('node_modules'), join(f.source.root, 'node_modules'), 'dir');
  f.source.git('add', '.');
  f.source.git('commit', '-qm', 'Factory fixture server');
  const revision = f.source.git('rev-parse', 'HEAD'),
    tree = f.source.git('rev-parse', 'HEAD^{tree}');
  const verification = join(f.source.root, '.issues/verification.json');
  const summary = JSON.parse(readFileSync(verification, 'utf8'));
  Object.assign(summary, { base: revision, snapshot_tree: tree });
  writeFileSync(verification, JSON.stringify(summary));
  const port = await freePort(),
    url = 'http://127.0.0.1:' + port;
  const log = [];
  const child = spawn(process.execPath, ['scripts/factory-ui.mjs', '--project', f.queue.root, '--port', String(port)], {
    cwd: f.source.root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => log.push(String(chunk)));
  child.stderr.on('data', (chunk) => log.push(String(chunk)));
  serverUrl = url;
  serverPort = port;
  initialChild = child;
  await waitFor(
    async () => {
      try {
        return Boolean(await readRuntime(url));
      } catch {
        return false;
      }
    },
    'fixture server: ' + log.join('')
  );
  return {
    ...f,
    child,
    port,
    url,
    options: { checkout: f.source.root, project: f.queue.root, url, verification, base: revision },
  };
}
test('managed deployment drains the real listener and checks replacement identity', async (t) => {
  const f = await deploymentFixture(t),
    before = await readRuntime(f.url);
  const result = await deployFactory(f.options),
    after = await readRuntime(f.url);
  assert.equal(result.status, 'ready');
  assert.notEqual(before.pid, after.pid);
  assert.equal(after.revision, before.revision);
  assert.equal(after.project, realpathSync(f.queue.root));
  assert.equal(JSON.parse(readFileSync(result.receipt)).status, 'ready');
  assert.equal(JSON.parse(readFileSync(join(f.queue.root, '.issues/factory.json'))).actions.length, 0);
});
test('deployment refuses dirty candidates and coordinator work without stopping the server', async (t) => {
  const f = await deploymentFixture(t),
    before = await readRuntime(f.url);
  writeFileSync(join(f.source.root, 'code.js'), 'unfinished work\n');
  await assert.rejects(deployFactory(f.options), /Commit and verify/);
  f.source.git('checkout', '--', 'code.js');
  mkdirSync(join(f.queue.root, '.issues/factory-progress.lock'));
  await assert.rejects(deployFactory(f.options), /coordinator operation/);
  assert.equal((await readRuntime(f.url)).pid, before.pid);
});
test('draining rejects new mutations until cancellation', async (t) => {
  const f = await deploymentFixture(t),
    session = await deploymentSession(f.url);
  await session.action('prepare');
  const page = await fetch(f.url),
    cookie = page.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
  const response = await fetch(f.url + '/api/evaluate', {
    method: 'POST',
    headers: { cookie, origin: f.url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: '{}',
  });
  assert.match((await response.json()).error, /restarting/);
  assert.deepEqual(await session.action('cancel'), { cancelled: true });
});
test('a failed replacement restores the previous listener and records recovery', async (t) => {
  const f = await deploymentFixture(t),
    candidate = gitFixture(t, 'deployment-candidate-').root;
  cpSync(f.source.root, candidate, { recursive: true });
  writeFileSync(join(candidate, 'scripts/factory-ui.mjs'), 'process.exit(1);\n');
  f.queue.git('config', 'user.name', 'Fixture');
  // Candidate has its own copied Git repository, never the queue checkout.
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', candidate, ...args], { encoding: 'utf8' }).trim();
  git('add', '.');
  git('commit', '-qm', 'Broken startup');
  const summary = JSON.parse(readFileSync(f.options.verification));
  summary.base = git('rev-parse', 'HEAD');
  summary.snapshot_tree = git('rev-parse', 'HEAD^{tree}');
  const verification = join(candidate, '.issues/replacement.json');
  writeFileSync(verification, JSON.stringify(summary));
  await assert.rejects(
    deployFactory({ ...f.options, checkout: candidate, verification, base: summary.base }),
    /verified candidate/
  );
  const runtime = await readRuntime(f.url);
  assert.equal(runtime.checkout, realpathSync(f.source.root));
});
test('verification output and log are available before the child exits; nonzero status is retained', async (t) => {
  const f = deliveryFixture(t),
    log = join(f.queue.root, '.issues/progress.log');
  let completed = false;
  const running = runVerificationProcess(
    process.execPath,
    ['-e', 'console.log("early progress");setTimeout(()=>{console.error("late failure");process.exit(7)},1000)'],
    { cwd: f.source.root },
    log
  ).then((result) => {
    completed = true;
    return result;
  });
  await waitFor(() => readFileSync(log, 'utf8').includes('early progress'), 'streamed output');
  assert.equal(completed, false);
  const result = await running;
  assert.equal(result.status, 7);
  assert.match(result.stdout, /early progress/);
  assert.match(result.stderr, /late failure/);
  assert.match(readFileSync(log, 'utf8'), /late failure/);
});
