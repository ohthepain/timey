import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { parse } from 'yaml';
import { captureFixture, proposal } from './factory-capture-fixture.mjs';
import { createCaptures } from './factory-ui/issue-capture.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { captureRoute } from './factory-ui/capture-routing.mjs';
import { readQueue } from './factory-ui/data.mjs';

const input = (description = 'Rename heading to Issues') => ({ requestId: randomUUID(), description });
const reports = (root) => readdirSync(join(root, '.issues')).filter((f) => /^\d.*\.md$/.test(f));
const bytes = (root, file) => readFileSync(join(root, '.issues', file), 'utf8');
function report(root, id) {
  const text = bytes(root, id + '.md');
  return { text, meta: parse(text.match(/^---\n([\s\S]*?)\n---/)[1]) };
}
function forbidWork(service) {
  for (const name of ['launch', 'startLifecycle', 'progressStart', 'integrate', 'evaluate', 'prepareWorker'])
    service[name] = () => {
      throw Error('Unexpected work launch: ' + name);
    };
  for (const name of ['reserve', 'recommend'])
    service.api[name] = () => {
      throw Error('Unexpected ledger work: ' + name);
    };
}

test('capture preserves exact original text, existing reports, metadata, distinct outcomes and individual skips without work', async (t) => {
  const { root, service } = captureFixture(t);
  forbidWork(service);
  const original = bytes(root, '20261025-existing.md'),
    ledger = bytes(root, 'factory.json');
  const description = '  Rename heading to “Issues”.\nAlso add a copy button.  ';
  service.captures = createCaptures(service, {
    assess: async () => ({ issues: [proposal('Rename heading to “Issues”.'), proposal('Also add a copy button.')] }),
  });
  const result = await service.captures.save(input(description));
  assert.equal(result.issues.length, 2);
  assert.equal(new Set(result.issues.map((i) => i.id)).size, 2);
  for (const item of result.issues) {
    assert.match(item.id, /^\d{8}T\d{9}-[a-f0-9]{16}$/);
    const saved = report(root, item.id);
    assert.ok(saved.text.includes('## Original request\n\n' + description + '\n\n'));
    assert.equal(saved.meta.autonomy, 'ask');
    assert.equal(saved.meta.grill_later, false);
    assert.equal(saved.meta.created, saved.meta.updated);
    assert.equal(saved.meta.state, 'implement');
    assert.deepEqual(
      saved.meta.lifecycle_history.map((s) => s.state),
      ['backlog', 'to-do', 'prototype']
    );
    assert.ok(
      saved.meta.lifecycle_history.every(
        (s) =>
          s.outcome === 'skipped' &&
          s.reason &&
          s.source.kind === 'original-report' &&
          s.evidence[0].path.endsWith(item.id + '.md')
      )
    );
  }
  assert.equal(bytes(root, '20261025-existing.md'), original);
  assert.equal(bytes(root, 'factory.json'), ledger);
  assert.equal(service.store.runs.length, 0);
  assert.equal(existsSync(join(root, '.issues/factory-ui/lifecycle.json')), false);
});

test('semantic grouping and bug/clarification/prototype routing preserve the assessor decisions', async (t) => {
  const { root, service } = captureFixture(t);
  for (const [description, role, state] of [
    ['1. Open page. 2. Return. Search disappears.', 'ready-for-repro', 'to-do'],
    ['Make managing old issues easier.', 'ready-for-grilling', 'backlog'],
    ['Compare graph and grouped list designs.', 'ready-to-prototype', 'prototype'],
  ]) {
    service.captures = createCaptures(service, { assess: async (text) => ({ issues: [proposal(text, role)] }) });
    const result = await service.captures.save(input(description));
    assert.equal(result.issues.length, 1);
    assert.equal(report(root, result.issues[0].id).meta.state, state);
  }
});

test('invalid requests/output and model failures publish no reports and can retry', async (t) => {
  const { root, service } = captureFixture(t);
  let calls = 0;
  service.captures = createCaptures(service, {
    assess: async () => {
      calls++;
      throw Error('Provider unavailable');
    },
  });
  for (const value of [
    input(' \n\t '),
    input(null),
    { ...input(), state: 'closed' },
    { requestId: '../escape', description: 'x' },
  ])
    await assert.rejects(service.captures.save(value));
  assert.equal(calls, 0);
  const request = input();
  await assert.rejects(service.captures.save(request), /Provider unavailable/);
  for (const issues of [
    [],
    [{ ...proposal('absent'), title: '' }],
    [{ ...proposal('absent') }],
    [{ ...proposal(request.description), initialRole: 'closed' }],
    [{ ...proposal(request.description), skips: [] }],
  ]) {
    service.captures = createCaptures(service, { assess: async () => ({ issues }) });
    await assert.rejects(service.captures.save(request));
  }
  assert.equal(reports(root).length, 1);
  service.captures = createCaptures(service, { assess: async (text) => ({ issues: [proposal(text)] }) });
  assert.equal((await service.captures.save(request)).issues.length, 1);
});

test('same-key concurrency, mismatched payload, response replay and restart retain exactly one set of IDs', async (t) => {
  const { root, service } = captureFixture(t);
  let release,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  service.captures = createCaptures(service, {
    assess: async (text) => {
      calls++;
      await gate;
      return { issues: [proposal(text)] };
    },
  });
  const request = input(),
    first = service.captures.save(request),
    second = service.captures.save(request);
  await assert.rejects(service.captures.save({ ...request, description: 'different' }), /another description/);
  assert.equal(service.captures.active, 1);
  release();
  const result = await first;
  assert.deepEqual(await second, result);
  assert.equal(calls, 1);
  service.captures = createCaptures(service, {
    assess: () => {
      throw Error('Must not reassess saved submission');
    },
  });
  assert.deepEqual(await service.captures.save(request), result);
  assert.equal(reports(root).length, 2);
  await assert.rejects(service.captures.save({ ...request, description: 'changed' }), /another description/);
});

test('different submissions, concurrent unrelated append and partial-publication disk recovery preserve reports', async (t) => {
  const { root, service } = captureFixture(t);
  let writes = 0;
  const request = input('One outcome. Another outcome.');
  const config = {
    assess: async () => ({ issues: [proposal('One outcome.'), proposal('Another outcome.')] }),
    publish: (path, content) => {
      if (++writes === 2) throw Error('Disk unavailable');
      writeFileSync(path, content, { flag: 'wx' });
    },
  };
  service.captures = createCaptures(service, config);
  await assert.rejects(service.captures.save(request), /Disk unavailable/);
  assert.equal(reports(root).length, 2);
  const existing = bytes(root, '20261025-existing.md') + '\nConcurrent note\n';
  writeFileSync(join(root, '.issues/20261025-existing.md'), existing);
  service.captures = createCaptures(service, {
    assess: () => {
      throw Error('Must recover stored output');
    },
  });
  const result = await service.captures.save(request);
  assert.equal(result.issues.length, 2);
  assert.equal(reports(root).length, 3);
  assert.equal(bytes(root, '20261025-existing.md'), existing);
  service.captures = createCaptures(service, { assess: async (text) => ({ issues: [proposal(text)] }) });
  await Promise.all([
    service.captures.save(input('Same description')),
    service.captures.save(input('Same description')),
  ]);
  assert.equal(reports(root).length, 5);
});

test('forced generated-ID collision never replaces an existing report', async (t) => {
  const { root, service } = captureFixture(t);
  let count = 0;
  service.captures = createCaptures(service, {
    random: () => (++count < 3 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb'),
    assess: async () => ({ issues: [proposal('x'), proposal('x')] }),
  });
  const result = await service.captures.save(input('x'));
  assert.notEqual(result.issues[0].id, result.issues[1].id);
  assert.equal(count, 3);
  assert.equal(reports(root).length, 3);
});

test('queue lock, policy change during assessment and preview reject without new reports', async (t) => {
  const { root, service } = captureFixture(t);
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  await assert.rejects(service.captures.save(input()), /Queue lock/);
  assert.equal(existsSync(lock), true);
  rmSync(lock, { recursive: true });
  service.captures = createCaptures(service, {
    assess: async (text) => {
      writeFileSync(join(root, '.issues/preferences.json'), '{"commit":false}');
      return { issues: [proposal(text)] };
    },
  });
  await assert.rejects(service.captures.save(input()), /policy changed/);
  service.reviewMode = 'preview';
  await assert.rejects(service.captures.save(input()), /preview/);
  assert.equal(reports(root).length, 1);
});

test('custom stages are retained; malformed lifecycle and unjustified investigation skips fail closed', (t) => {
  const { service } = captureFixture(t);
  const stages = readQueue(service.root).lifecycle;
  stages.find((s) => s.state === 'to-do').next = 'custom-check';
  stages.push({ role: 'custom', state: 'custom-check', next: 'prototype', exit: 'Required human check' });
  assert.equal(captureRoute(stages, proposal('x')).state, 'custom-check');
  assert.throws(() => captureRoute(stages, { ...proposal('x'), reproduction: 'required' }), /investigation/);
  stages.find((s) => s.state === 'custom-check').next = 'missing';
  assert.throws(() => captureRoute(stages, proposal('x')), /broken|unambiguous/);
});

test('real HTTP guards, pause/drain, capture and replay leave work untouched', async (t) => {
  const { root, service } = captureFixture(t);
  forbidWork(service);
  const server = createFactoryServer(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const request = input('<script>data</script>');
  const headers = { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' };
  const post = (extra = {}, body = request) =>
    fetch(url + '/api/issue-capture', {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  for (const extra of [
    { cookie: '' },
    { origin: 'https://elsewhere.invalid' },
    { 'x-factory-action': '' },
    { 'content-type': 'text/plain' },
  ])
    assert.equal((await post(extra)).status, 400, JSON.stringify(extra));
  const forgedHost = await new Promise((resolve, reject) => {
    const req = httpRequest(
      url + '/api/issue-capture',
      { method: 'POST', headers: { ...headers, host: 'localhost' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(request));
  });
  assert.equal(forgedHost, 400);
  assert.equal((await post({}, '{')).status, 400);
  assert.equal((await post({}, input('x'.repeat(65536)))).status, 400);
  service.serverControl.pause();
  assert.equal((await post()).status, 400);
  service.serverControl.cancel();
  service.deploymentDraining = true;
  assert.equal((await post()).status, 400);
  service.deploymentDraining = false;
  const ledger = bytes(root, 'factory.json');
  const saved = await post();
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.deepEqual(await (await post()).json(), result);
  assert.equal(bytes(root, 'factory.json'), ledger);
  assert.equal(service.store.runs.length, 0);
  assert.equal(reports(root).length, 2);
});

test('legacy canonical tables route without migration; receipt corruption and uncertain ownership fail closed', async (t) => {
  const { root, service } = captureFixture(t);
  const states = [
    'ready-for-grilling',
    'ready-for-repro',
    'ready-to-prototype',
    'ready-to-fix',
    'ready-to-verify',
    'ready-for-commit',
    'ready-to-close',
    'closed',
  ];
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| State | Meaning |\n| --- | --- |\n' + states.map((state) => `| ${state} | Required evidence |`).join('\n')
  );
  const request = input();
  const result = await service.captures.save(request);
  assert.equal(result.issues[0].state, 'ready-to-fix');
  const receipt = join(root, '.issues/factory-ui/captures', request.requestId + '.json');
  const corrupt = JSON.parse(readFileSync(receipt, 'utf8'));
  corrupt.reports[0].id = '../outside';
  writeFileSync(receipt, JSON.stringify(corrupt));
  await assert.rejects(service.captures.save(request));
  const owner = join(root, '.issues/factory-ui-server.lock/owner.json');
  writeFileSync(owner, JSON.stringify({ pid: -1 }));
  await assert.rejects(service.captures.save(input()), /Another UI server/);
  assert.deepEqual(JSON.parse(readFileSync(owner)), { pid: -1 });
  assert.equal(reports(root).length, 2);
});

test('a partial report edited outside capture is preserved and cannot be overwritten on recovery', async (t) => {
  const { root, service } = captureFixture(t);
  let writes = 0;
  service.captures = createCaptures(service, {
    assess: async () => ({ issues: [proposal('first'), proposal('second')] }),
    publish: (path, content) => {
      if (++writes === 2) throw Error('Disk failure');
      writeFileSync(path, content, { flag: 'wx' });
    },
  });
  const request = input('first second');
  await assert.rejects(service.captures.save(request), /Disk failure/);
  const captured = reports(root).find((name) => name !== '20261025-existing.md');
  const edited = bytes(root, captured) + '\nOwner note\n';
  writeFileSync(join(root, '.issues', captured), edited);
  await assert.rejects(service.captures.save(request), /changed contents/);
  assert.equal(bytes(root, captured), edited);
  assert.equal(reports(root).length, 2);
});

test('custom entry stages remain first and unknown disconnected lifecycle rows are rejected', async (t) => {
  const { root, service } = captureFixture(t);
  const path = join(root, '.issues/triage-labels.md');
  const original = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    original.replace('| ready-for-grilling', '| custom | intake | backlog | Review intake |\n| ready-for-grilling')
  );
  const result = await service.captures.save(input());
  const captured = report(root, result.issues[0].id);
  assert.equal(captured.meta.state, 'intake');
  assert.deepEqual(captured.meta.lifecycle_history, []);
  writeFileSync(path, original + '\n| unknown-role | unknown-state | closed | Invalid |');
  await assert.rejects(service.captures.save(input()), /Unknown lifecycle role/);
});
