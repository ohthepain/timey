import { gitFixture } from './git-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { spawn } from 'node:child_process';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { retainReadiness } from './factory-deploy-readiness.mjs';
import { deployFactory } from './factory-deploy.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';
import { deploymentSession, waitFor, portReleased, readyRuntime } from './factory-deploy-transport.mjs';
import { runVerificationProcess } from './verify-process.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function deploymentFixture(t, diagnosticFailures = false) {
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
  if (diagnosticFailures) installReadinessFailures(f.source.root);
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
  const receipt = JSON.parse(readFileSync(result.receipt));
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.readiness.candidate.outcome, 'ready');
  const diagnostic = JSON.parse(readFileSync(receipt.readiness.candidate.path)).waits.candidate;
  assert.equal(diagnostic.recent.at(-1).outcome, 'ready');
  assert.deepEqual(diagnostic.recent.at(-1).mismatches, []);
  assert.equal(diagnostic.recent.at(-1).observed.revision, after.revision);
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
  const receiptPath = deploymentReceipt(f.queue.root);
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(receipt.recovery.status, 'ready');
  assert.equal(receipt.readiness.recovery.outcome, 'ready');
  const diagnostics = JSON.parse(readFileSync(receipt.readiness.recovery.path));
  assert.equal(diagnostics.waits.candidate.failures.transport.error.code, 'ECONNREFUSED');
  assert.equal(diagnostics.waits.recovery.recent.at(-1).outcome, 'ready');
  retainDeploymentEvidence(receiptPath);
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

async function runtimeProbeFixture(t, respond) {
  const server = createHTTPServer(respond);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise((done) => server.close(done)));
  return 'http://127.0.0.1:' + server.address().port;
}
const probeIdentity = {
  checkout: '/fixture/source',
  revision: 'a'.repeat(40),
  project: '/fixture/queue',
  mode: 'live',
  sourceChanged: false,
};
function probeResponse(request, response, identity = probeIdentity) {
  if (request.url === '/') {
    response.setHeader('Set-Cookie', 'session=DO-NOT-RETAIN');
    return response.end('fixture page');
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ...identity, token: 'DO-NOT-RETAIN' }));
}
async function probe(url) {
  const observations = [];
  const ready = await readyRuntime(
    url,
    probeIdentity.checkout,
    probeIdentity.revision,
    probeIdentity.project,
    (observation) => observations.push(observation)
  );
  assert.equal(observations.length, 1, 'each readiness attempt retains one observation');
  assert.equal(JSON.stringify(observations).includes('DO-NOT-RETAIN'), false);
  return { ready, observation: observations[0] };
}
test('readiness observations distinguish HTTP failure, transport failure, mismatch and success without response secrets', async (t) => {
  const http = await runtimeProbeFixture(t, (request, response) => {
    response.statusCode = 503;
    response.end('DO-NOT-RETAIN');
  });
  const failed = await probe(http);
  assert.equal(failed.ready, false);
  assert.equal(failed.observation.failure, 'http');
  assert.equal(failed.observation.http.at(-1).status, 503);
  const mismatch = await runtimeProbeFixture(t, (request, response) =>
    probeResponse(request, response, { ...probeIdentity, revision: 'wrong' })
  );
  const wrong = await probe(mismatch);
  assert.equal(wrong.ready, false);
  assert.deepEqual(wrong.observation.mismatches, ['revision']);
  assert.equal(wrong.observation.observed.revision, 'wrong');
  assert.deepEqual(wrong.observation.expected, probeIdentity);
  const good = await runtimeProbeFixture(t, probeResponse);
  const success = await probe(good);
  assert.equal(success.ready, true);
  assert.equal(success.observation.outcome, 'ready');
  const port = await freePort();
  const transport = await probe('http://127.0.0.1:' + port);
  assert.equal(transport.ready, false);
  assert.equal(transport.observation.failure, 'transport');
  assert.equal(transport.observation.error.code, 'ECONNREFUSED');
});

// Only disposable fixture servers use this boot counter; the production entry remains unchanged.
function installReadinessFailures(root) {
  const path = join(root, 'scripts/factory-ui.mjs');
  const source = readFileSync(path, 'utf8').replace(
    'function main() {',
    `function main() {
  if (diagnosticBoot() > 1) return diagnosticListener();`
  );
  writeFileSync(
    path,
    `import {createServer as diagnosticHTTP} from 'node:http';
import {existsSync as diagnosticExists,readFileSync as diagnosticRead,writeFileSync as diagnosticWrite} from 'node:fs';
` +
      source +
      `
function diagnosticFile() { return process.argv[process.argv.indexOf('--project')+1]+'/.issues/diagnostic-boots'; }
function diagnosticBoot() {
  const file=diagnosticFile();const boot=diagnosticExists(file)?Number(diagnosticRead(file,'utf8'))+1:1;
  diagnosticWrite(file,String(boot));return boot;
}
function diagnosticListener() {
  const boot=Number(diagnosticRead(diagnosticFile(),'utf8'));
  const port=Number(process.argv[process.argv.indexOf('--port')+1]);
  const server=diagnosticHTTP((request,response)=>{
    if(boot===2){response.statusCode=503;return response.end('DO-NOT-RETAIN');}
    if(request.url==='/'){response.setHeader('Set-Cookie','session=DO-NOT-RETAIN');return response.end('fixture page');}
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({pid:process.pid,checkout:'wrong-checkout',revision:'wrong-revision',project:'wrong-project',mode:'preview',sourceChanged:true,secret:'DO-NOT-RETAIN'}));
  });
  server.listen(port,'127.0.0.1',()=>console.log('Disposable readiness failure listener: '+boot));
  process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
}
`
  );
}
test('unsuccessful candidate and recovery waits retain HTTP failures and identity mismatches with the recovery lock intact', async (t) => {
  const f = await deploymentFixture(t, true);
  await assert.rejects(deployFactory(f.options), /Timed out waiting for the verified candidate/);
  const owner = JSON.parse(readFileSync(join(f.queue.root, '.issues/factory-deploy.lock/owner.json')));
  const receipt = JSON.parse(readFileSync(owner.receipt));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.recovery.status, 'failed');
  assert.match(receipt.recovery.error, /Timed out waiting for the previous server/);
  assert.equal(receipt.readiness.candidate.outcome, 'read-failed');
  assert.equal(receipt.readiness.recovery.outcome, 'mismatch');
  const diagnostic = JSON.parse(readFileSync(receipt.readiness.candidate.path));
  assert.equal(diagnostic.waits.candidate.failures.http.http.at(-1).status, 503);
  assert.equal(diagnostic.waits.candidate.failures.http.http.at(-1).path, '/');
  const mismatch = diagnostic.waits.recovery.failures.identity;
  assert.equal(mismatch.expected.checkout, realpathSync(f.source.root));
  assert.equal(mismatch.observed.checkout, 'wrong-checkout');
  assert.ok(mismatch.mismatches.includes('revision'));
  assert.equal(mismatch.observed.sourceChanged, true);
  assert.equal(JSON.stringify(diagnostic).includes('DO-NOT-RETAIN'), false);
  for (const wait of Object.values(diagnostic.waits)) {
    assert.ok(wait.attempts >= 1);
    assert.ok(wait.recent.length <= 20);
    assert.ok(wait.firstFailure);
  }
  retainDeploymentEvidence(owner.receipt);
});

test('readiness diagnostic retention is bounded and preserves each failure kind beyond the recent tail', (t) => {
  const { root } = gitFixture(t, 'readiness-retention-');
  const path = join(root, 'receipt.json'),
    receipt = { status: 'prepared' };
  for (const phase of ['candidate', 'recovery']) populateReadiness(receipt, path, phase);
  const saved = JSON.parse(readFileSync(path));
  const data = JSON.parse(readFileSync(path + '.readiness.json'));
  for (const phase of ['candidate', 'recovery']) {
    assert.equal(saved.readiness[phase].attempts, 34);
    assert.equal(saved.readiness[phase].outcome, 'ready');
    const wait = data.waits[phase];
    assert.equal(wait.recent.length, 20);
    assert.equal(wait.firstFailure.failure, 'transport');
    assert.deepEqual(Object.keys(wait.failures), ['transport', 'http', 'decode', 'identity']);
  }
});
test('readiness observations preserve runtime HTTP status and safely describe malformed JSON', async (t) => {
  const runtimeFailure = await runtimeProbeFixture(t, (request, response) => {
    if (request.url === '/') return probeResponse(request, response);
    response.statusCode = 401;
    response.end('DO-NOT-RETAIN');
  });
  const failed = await probe(runtimeFailure);
  assert.equal(failed.ready, false);
  assert.equal(failed.observation.failure, 'http');
  assert.equal(failed.observation.http.at(-1).path, '/api/runtime');
  assert.equal(failed.observation.http.at(-1).status, 401);
  const malformed = await runtimeProbeFixture(t, (request, response) => {
    if (request.url === '/') return probeResponse(request, response);
    response.end('DO-NOT-RETAIN');
  });
  const decoded = await probe(malformed);
  assert.equal(decoded.ready, false);
  assert.equal(decoded.observation.failure, 'decode');
  assert.equal(decoded.observation.error.name, 'SyntaxError');
});

function populateReadiness(receipt, path, phase) {
  for (const failure of ['transport', 'http', 'decode', 'identity'])
    retainReadiness(receipt, path, phase, { outcome: 'read-failed', failure, expected: probeIdentity });
  for (let n = 0; n < 30; n++)
    retainReadiness(receipt, path, phase, {
      outcome: 'ready',
      failure: null,
      expected: probeIdentity,
      observed: probeIdentity,
    });
}
function deploymentReceipt(root) {
  const directory = join(root, '.issues/evidence');
  const file = readdirSync(directory).find((name) => /^deployment-[^.]+\.json$/.test(name));
  assert.ok(file, 'the deployment receipt exists');
  return join(directory, file);
}
function retainDeploymentEvidence(path) {
  const retained = mkdtempSync(join(tmpdir(), 'timey-readiness-failure-evidence-'));
  for (const suffix of ['', '.readiness.json', '.log']) cpSync(path + suffix, join(retained, basename(path) + suffix));
  console.log('Retained deployment readiness evidence: ' + retained);
}
