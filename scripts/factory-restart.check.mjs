import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  realpathSync,
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { restartFactory } from './factory-restart.mjs';
import { startFactory, waitFor, portReleased } from './factory-deploy-transport.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';

async function fixture(t) {
  let serverUrl, serverPort, initialChild;
  // Stop replacement processes before the repository fixture removes their source.
  t.after(async () => {
    if (serverUrl) {
      try {
        process.kill((await readRuntime(serverUrl)).pid, 'SIGTERM');
      } catch {}
    }
    initialChild?.kill('SIGTERM');
    if (serverPort) await waitFor(() => portReleased(serverPort), 'test server shutdown');
  });
  const f = deliveryFixture(t);
  cpSync(resolve('scripts'), join(f.source.root, 'scripts'), { recursive: true });
  writeFileSync(join(f.source.root, '.gitignore'), '.issues/\nnode_modules\n');
  writeFileSync(join(f.source.root, 'package.json'), '{"type":"module"}\n');
  symlinkSync(resolve('node_modules'), join(f.source.root, 'node_modules'), 'dir');
  f.source.git('add', '.');
  f.source.git('commit', '-qm', 'Restart fixture');
  const verification = join(f.source.root, '.issues/verification.json');
  const original = JSON.parse(readFileSync(verification, 'utf8'));
  const verify = () => {
    const summary = {
      ...original,
      base: f.source.git('rev-parse', 'HEAD'),
      snapshot_tree: f.source.git('rev-parse', 'HEAD^{tree}'),
    };
    writeFileSync(verification, JSON.stringify(summary));
    return summary;
  };
  verify();
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const child = startFactory(
    realpathSync(f.source.root),
    realpathSync(f.queue.root),
    port,
    join(f.queue.root, '.issues/initial-server.log')
  );
  serverUrl = url;
  serverPort = port;
  initialChild = child;
  await waitFor(async () => {
    try {
      return (await readRuntime(url)).pid === child.pid;
    } catch {
      return false;
    }
  }, 'test server');
  const messages = [];
  return {
    ...f,
    child,
    url,
    port,
    verify,
    verification,
    messages,
    options: {
      checkout: f.source.root,
      project: f.queue.root,
      url,
      verification,
      progress: (text) => messages.push(text),
    },
  };
}

test('restart replaces a changed installed source using saved evidence and verifies the new PID and hash', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.source.root, 'restart-marker.js'), 'export const marker = true;\n');
  f.source.git('add', 'restart-marker.js');
  f.source.git('commit', '-qm', 'Changed source');
  f.verify();
  assert.equal((await readRuntime(f.url)).sourceChanged, true);
  const result = await restartFactory(f.options);
  assert.equal(result.status, 'ready');
  assert.notEqual(result.pid, f.child.pid);
  const runtime = await readRuntime(f.url);
  assert.equal(runtime.pid, result.pid);
  assert.equal(runtime.revision, f.source.git('rev-parse', 'HEAD'));
  assert.equal(runtime.sourceChanged, false);
  assert.equal(f.messages.at(-1).startsWith('Ready:'), true);
  assert.equal(JSON.parse(readFileSync(result.receipt)).status, 'ready');
});

test('dirty source or stale verification fails before pausing or stopping the server', async (t) => {
  const f = await fixture(t);
  const path = join(f.source.root, 'uncommitted.js');
  writeFileSync(path, 'keep me');
  await assert.rejects(restartFactory(f.options), /uncommitted changes were left untouched/);
  assert.equal(readFileSync(path, 'utf8'), 'keep me');
  rmSync(path);
  const summary = JSON.parse(readFileSync(f.verification));
  summary.snapshot_tree = 'wrong';
  writeFileSync(f.verification, JSON.stringify(summary));
  await assert.rejects(restartFactory(f.options), /exact candidate tree/);
  const runtime = await readRuntime(f.url);
  assert.equal(runtime.pid, f.child.pid);
  assert.equal(runtime.server.phase, 'idle');
});

test('restart waits for a held integration lock and times out without stopping work or deleting it', async (t) => {
  const f = await fixture(t);
  const lock = join(f.queue.root, '.issues/factory-integration.lock');
  mkdirSync(lock);
  await assert.rejects(
    restartFactory({ ...f.options, timeout: 300 }),
    /work stays saved and paused; no process was stopped/
  );
  assert.equal((await readRuntime(f.url)).pid, f.child.pid);
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(join(f.queue.root, '.issues/factory-deploy.lock')), false);
});

test('restart discovers matching saved evidence and never reports ready if the replacement exits', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.source.root, 'scripts/factory-ui.mjs'), 'process.exit(3);\n');
  f.source.git('add', 'scripts/factory-ui.mjs');
  f.source.git('commit', '-qm', 'Failing startup fixture');
  const summary = f.verify();
  const evidence = join(f.source.root, '.issues/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'matching-summary.json'), JSON.stringify(summary));
  await assert.rejects(
    restartFactory({ ...f.options, verification: undefined, timeout: 10000 }),
    /replacement server exited/
  );
  assert.equal(
    f.messages.some((line) => line.startsWith('Ready:')),
    false
  );
  const path = join(f.queue.root, '.issues/evidence');
  const receipt = JSON.parse(
    readFileSync(
      join(
        path,
        readdirSync(path).find((name) => /^restart-.*\.json$/.test(name))
      )
    )
  );
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.previousStopped, true);
});

test('restart help is available without a server or verification', () => {
  const result = spawnSync(process.execPath, ['scripts/factory-restart.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /never runs tests/);
});

test('an unknown deployment lock is preserved without pausing or stopping the server', async (t) => {
  const f = await fixture(t);
  const lock = join(f.queue.root, '.issues/factory-deploy.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"owner":"another operation"}');
  await assert.rejects(restartFactory(f.options), /EEXIST/);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"owner":"another operation"}');
  const runtime = await readRuntime(f.url);
  assert.equal(runtime.pid, f.child.pid);
  assert.equal(runtime.server.phase, 'idle');
});
