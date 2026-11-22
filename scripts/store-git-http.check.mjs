import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment } from './factory-ui/common.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';

const digest = (body) => createHash('sha256').update(body).digest('hex');
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: cleanEnvironment(),
    stdio: 'pipe',
  }).trim();
const authorization = 'unchanged-fixture-authorization';

async function backend(projectRoot, request, body) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...cleanEnvironment(),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] || '',
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: 'fixture',
      REMOTE_ADDR: '127.0.0.1',
      SERVER_PROTOCOL: 'HTTP/1.1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [],
    stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(body);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const result = Buffer.concat(stdout);
  const boundary = result.indexOf('\r\n\r\n');
  assert.ok(boundary >= 0, 'Git CGI must return a valid header block.');
  const headers = result.subarray(0, boundary).toString().split('\r\n');
  return { headers, body: result.subarray(boundary + 4) };
}

async function smartHttp(directory, { rejectChunked, loseSuccessfulReply }) {
  const requests = [];
  let replyLost = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const push = request.method === 'POST' && request.url.endsWith('/git-receive-pack');
      const entry = {
        method: request.method,
        path: request.url.split('?')[0],
        chunked: request.headers['transfer-encoding'] === 'chunked',
        bytes: body.length,
        authorized: request.headers['x-timey-test-authorization'] === authorization,
      };
      requests.push(entry);
      assert.equal(entry.authorized, true, 'Every transport attempt must retain its authorization.');
      if (push && rejectChunked && entry.chunked) {
        entry.rejectedChunked = true;
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        return response.end('This transport rejects chunked uploads.');
      }
      const result = await backend(directory, request, body);
      entry.cgiStatus = result.headers.find((header) => header.startsWith('Status:')) || '200';
      if (push && body.length > 1048576 && loseSuccessfulReply && !replyLost) {
        replyLost = true;
        entry.lostSuccessfulReply = true;
        const remote = join(directory, 'remote.git');
        const accepted = git(remote, 'rev-parse', 'refs/heads/issue-queue');
        const tree = git(remote, 'rev-parse', accepted + '^{tree}');
        entry.peerHead = git(
          remote,
          '-c',
          'user.name=Concurrent peer',
          '-c',
          'user.email=peer@example.invalid',
          'commit-tree',
          tree,
          '-p',
          accepted,
          '-m',
          'A peer advanced the metadata branch'
        );
        git(remote, 'update-ref', 'refs/heads/issue-queue', entry.peerHead, accepted);
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        return response.end('The accepted push response was lost.');
      }
      for (const header of result.headers) {
        const split = header.indexOf(':');
        if (split < 0) continue;
        const key = header.slice(0, split),
          value = header.slice(split + 1).trim();
        if (key === 'Status') response.statusCode = Number(value.split(' ')[0]);
        else response.setHeader(key, value);
      }
      response.end(result.body);
    } catch (error) {
      requests.at(-1).error = error.message;
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/remote.git`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'timey-http-git-'));
  const root = join(directory, 'source'),
    remote = join(directory, 'remote.git');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'source');
  git(root, 'config', 'user.name', 'HTTP Git contract');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  const postBuffer = options.loseSuccessfulReply ? '16777216' : '1048576';
  git(root, 'config', 'http.postBuffer', postBuffer);
  git(root, 'config', 'http.extraHeader', 'X-Timey-Test-Authorization: ' + authorization);
  await writeFile(join(root, 'source.txt'), 'Unchanged source.\n');
  git(root, 'add', 'source.txt');
  git(root, 'commit', '-qm', 'Source');
  await mkdir(remote);
  git(remote, 'init', '--bare', '-q');
  git(remote, 'config', 'http.receivepack', 'true');
  git(remote, 'config', 'core.hooksPath', '/dev/null');
  const http = await smartHttp(directory, options);
  git(root, 'remote', 'add', 'origin', http.url);
  const trace = join(directory, 'client.trace');
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  let artifact;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    artifact = await openArtifactStore(
      { id: 'http-artifacts', kind: 'git', branch: 'issue-queue' },
      { root, projectId: 'http-fixture-' + randomUUID() }
    );
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }
  t.after(async () => {
    await artifact.close();
    await http.close();
    await rm(directory, { recursive: true, force: true });
  });
  const before = { head: git(root, 'rev-parse', 'HEAD'), index: digest(await readFile(join(root, '.git/index'))) };
  return { root, remote, artifact, http, before, postBuffer, trace };
}

async function verifyRetry(f) {
  const pushes = (await readFile(f.trace, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((event) => event.event === 'start' && event.argv.includes('push'))
    .map((event) => event.argv);
  assert.equal(pushes.length, 2, 'Only the original push and one buffered retry are allowed.');
  assert.deepEqual(
    pushes[0].slice(pushes[0].indexOf('push')),
    pushes[1].slice(pushes[1].indexOf('push')),
    'The retry must preserve the exact commit, destination and expected-tip lease.'
  );
  assert.equal(pushes[0].includes('http.postBuffer=67108864'), false);
  assert.equal(pushes[1].includes('http.postBuffer=67108864'), true);
}

async function verifySource(f) {
  assert.deepEqual(
    { head: git(f.root, 'rev-parse', 'HEAD'), index: digest(await readFile(join(f.root, '.git/index'))) },
    f.before
  );
  assert.equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'Unchanged source.\n');
  assert.equal(
    git(f.root, 'config', '--get', 'http.postBuffer'),
    f.postBuffer,
    'The fallback must not alter repository configuration.'
  );
}

test('Git artifact publication retries HTTP400 chunked rejection with the same authorized leased commit', async (t) => {
  const f = await fixture(t, { rejectChunked: true });
  const bytes = randomBytes(2 * 1048576);
  const ref = await f.artifact.put({ body: bytes }).catch((error) => {
    t.diagnostic(JSON.stringify(f.http.requests));
    throw error;
  });
  assert.deepEqual(await f.artifact.get(ref), bytes);
  assert.equal(ref.sha256, digest(bytes));
  assert.equal(f.http.requests.filter((request) => request.rejectedChunked).length, 1);
  assert.ok(
    f.http.requests.some(
      (request) => request.path.endsWith('/git-receive-pack') && !request.chunked && request.bytes > 1048576
    )
  );
  assert.equal(git(f.remote, 'rev-list', '--count', 'refs/heads/issue-queue'), '1');
  await verifyRetry(f);
  await verifySource(f);
});

test('Git artifact publication reconciles HTTP400 after the original commit was already accepted', async (t) => {
  const f = await fixture(t, { loseSuccessfulReply: true });
  const bytes = randomBytes(2 * 1048576);
  const ref = await f.artifact.put({ body: bytes }).catch((error) => {
    t.diagnostic(JSON.stringify(f.http.requests));
    throw error;
  });
  assert.deepEqual(await f.artifact.get(ref), bytes);
  assert.equal(f.http.requests.filter((request) => request.lostSuccessfulReply).length, 1);
  assert.equal(
    git(f.remote, 'rev-list', '--count', 'refs/heads/issue-queue'),
    '2',
    'Only the artifact commit and concurrent peer commit must exist.'
  );
  await verifyRetry(f);
  assert.equal(
    git(f.remote, 'rev-parse', 'refs/heads/issue-queue'),
    f.http.requests.find((request) => request.peerHead).peerHead,
    'An uncertain push retry must never overwrite a newer peer tip.'
  );
  await verifySource(f);
});
