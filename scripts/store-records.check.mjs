import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { createFactoryPool, ensureFactoryDatabase } from './factory-ui/stores/postgres-connection.mjs';
import { cleanEnvironment } from './factory-ui/common.mjs';

const providers = (process.env.TIMEY_STORE_TEST_PROVIDERS || 'files,git').split(',');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fails = (code) => (error) => error.code === code;

test(
  'git: fresh advertised commits reuse local objects and fetch missing peer commits',
  { skip: !providers.includes('git') },
  async (t) => {
    const f = await fixture(t, 'git');
    const trace = join(dirname(f.roots[0]), 'git-transport.trace');
    const previous = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      const one = await f.open();
      const two = await f.open(1);
      const starts = async () =>
        (await readFile(trace, 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse)
          .filter((event) => event.event === 'start' && event.argv[0] === 'git');
      const newCommands = async (before) => (await starts()).slice(before.length);
      const created = await one.commit({
        operationId: 'local-commit',
        expected: [{ key: 'catalog/a', revision: null }],
        writes: [{ key: 'catalog/a', value: 'first' }],
      });
      let before = await starts();
      assert.equal((await one.get('catalog/a')).value, 'first');
      assert.equal(
        (await newCommands(before)).filter((event) => event.argv.includes('fetch')).length,
        0,
        'A confirmed locally created commit needs no fetch after checking its authoritative remote OID.'
      );
      assert.equal((await newCommands(before)).filter((event) => event.argv.includes('ls-remote')).length, 1);
      before = await starts();
      assert.equal((await two.get('catalog/a')).value, 'first');
      assert.equal((await newCommands(before)).filter((event) => event.argv.includes('fetch')).length, 1);
      await two.commit({
        operationId: 'peer-update',
        expected: [{ key: 'catalog/a', revision: created.records[0].revision }],
        writes: [{ key: 'catalog/a', value: 'peer changed' }],
      });
      before = await starts();
      assert.equal((await one.get('catalog/a')).value, 'peer changed');
      assert.equal((await newCommands(before)).filter((event) => event.argv.includes('fetch')).length, 1);
      before = await starts();
      const callbackFailure = Object.assign(Error('Pinned read callback failed.'), { code: 'STORE_CONFLICT' });
      await assert.rejects(
        one.readSnapshot(() => {
          throw callbackFailure;
        }),
        { code: 'STORE_CONFLICT' }
      );
      assert.equal(
        (await newCommands(before)).filter((event) => event.argv.includes('fetch')).length,
        0,
        'A read callback failure must not be interpreted as a missing local commit.'
      );
      assert.deepEqual(
        (await one.list('catalog/')).map((record) => record.value),
        ['peer changed']
      );
      await f.checkSource();
    } finally {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previous;
    }
  }
);

test(
  'git: pinned prefix lists batch metadata reads and preserve Unicode and caller isolation',
  { skip: !providers.includes('git') },
  async (t) => {
    const f = await fixture(t, 'git');
    const one = await f.open();
    const writes = [
      { key: 'catalog/z', value: { text: 'Ångström 🎹 漢字' } },
      { key: 'catalog/a', value: { text: 'First\nSecond' } },
      { key: 'claims/a', value: { owner: 'runner' } },
      { key: 'commands/a', value: { action: 'stop' } },
      ...Array.from({ length: 125 }, (_, index) => ({ key: `extra/${index}`, value: { index } })),
    ];
    for (let offset = 0; offset < writes.length; offset += 99) {
      const batch = writes.slice(offset, offset + 99);
      await one.commit({
        operationId: 'batch-list-' + offset,
        expected: batch.map(({ key }) => ({ key, revision: null })),
        writes: batch,
      });
    }
    const trace = join(dirname(f.roots[0]), 'git-batch.trace');
    const previous = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      const observed = await f.open();
      await observed.readSnapshot(async (pinned) => {
        const catalog = await pinned.list('catalog/');
        assert.deepEqual(
          catalog.map(({ key }) => key),
          ['catalog/a', 'catalog/z']
        );
        assert.equal(catalog[1].value.text, writes[0].value.text);
        catalog[1].value.text = 'Changed by caller';
        assert.equal((await pinned.list('catalog/'))[1].value.text, writes[0].value.text);
        const selected = await pinned.get('catalog/z');
        assert.equal(selected.value.text, writes[0].value.text);
        selected.value.text = 'Changed selected record';
        assert.equal((await pinned.get('catalog/z')).value.text, writes[0].value.text);
        assert.equal((await pinned.list('claims/')).length, 1);
        assert.equal((await pinned.list('commands/')).length, 1);
        assert.deepEqual(await pinned.list('missing/'), []);
        assert.equal((await pinned.list('extra/')).length, 125);
      });
      const commands = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
        .filter((event) => event.event === 'start' && event.argv[0] === 'git');
      assert.equal(
        commands.filter(({ argv }) => argv.includes('ls-tree') && argv.includes('-rz')).length,
        1,
        'A pinned record set is enumerated once across prefixes.'
      );
      assert.equal(
        commands.filter(({ argv }) => argv.includes('show')).length,
        2,
        'Only the two explicit single-record reads use git show.'
      );
      assert.equal(
        commands.filter(({ argv }) => argv.includes('--batch')).length,
        2,
        'Raw record contents use bounded batches shared across all prefix lists.'
      );
    } finally {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previous;
    }
    await f.checkSource();
  }
);

test('git: batched lists reject nonregular metadata records', { skip: !providers.includes('git') }, async (t) => {
  const f = await fixture(t, 'git');
  const one = await f.open();
  await one.commit({
    operationId: 'regular-list',
    expected: [{ key: 'catalog/a', revision: null }],
    writes: [{ key: 'catalog/a', value: 'record' }],
  });
  const directory = dirname(f.roots[0]);
  const checkout = join(directory, 'metadata-edit');
  const remote = join(directory, 'remote.git');
  execFileSync('git', ['clone', '--branch', 'issue-queue', remote, checkout], { stdio: 'pipe' });
  const path = git(checkout, 'ls-files')
    .split('\n')
    .find((entry) => entry.includes('/records/'));
  assert.ok(path);
  git(checkout, 'update-index', '--chmod=+x', '--', path);
  git(
    checkout,
    '-c',
    'user.name=Store fixture',
    '-c',
    'user.email=fixture@timey.invalid',
    'commit',
    '-m',
    'Invalid metadata mode'
  );
  git(checkout, 'push', 'origin', 'issue-queue');
  await assert.rejects(one.list('catalog/'), {
    code: 'STORE_INVALID',
    message: 'Git store records must be regular files.',
  });
  await f.checkSource();
});

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: cleanEnvironment(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

async function fixture(t, kind) {
  const directory = await mkdtemp(join(tmpdir(), 'timey-store-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactDirectory = join(directory, 'artifacts');
  await mkdir(artifactDirectory);
  const artifacts = {
    async put({ body, mediaType }) {
      const digest = sha(body);
      await writeFile(join(artifactDirectory, digest), body);
      return { storeId: 'fixture-artifacts', key: digest, sha256: digest, bytes: body.length, mediaType };
    },
    async get(ref) {
      const body = await readFile(join(artifactDirectory, ref.key));
      assert.equal(sha(body), ref.sha256);
      assert.equal(body.length, ref.bytes);
      return body;
    },
  };
  const projectId = `test-project-${randomUUID()}`;
  const config = { id: `test-records-${randomUUID()}`, kind };
  const roots = [join(directory, 'one'), join(directory, 'two')];
  await Promise.all(roots.map((root) => mkdir(root)));
  let unchanged;
  if (kind === 'files') config.directory = join(directory, 'records');
  if (kind === 'git') {
    const remote = join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    git(roots[0], 'init', '-b', 'main');
    git(roots[0], 'config', 'user.name', 'Store fixture');
    git(roots[0], 'config', 'user.email', 'fixture@timey.invalid');
    await writeFile(join(roots[0], 'source.txt'), 'base\n');
    git(roots[0], 'add', 'source.txt');
    git(roots[0], 'commit', '-m', 'Source fixture');
    git(roots[0], 'remote', 'add', 'origin', remote);
    git(roots[0], 'push', 'origin', 'main');
    execFileSync('git', ['clone', '--branch', 'main', remote, roots[1]], { stdio: 'pipe' });
    for (const root of roots) {
      await writeFile(join(root, 'source.txt'), 'staged\n');
      git(root, 'add', 'source.txt');
      await writeFile(join(root, 'source.txt'), 'unstaged\n');
    }
    config.branch = 'issue-queue';
    unchanged = roots.map((root) => [
      git(root, 'rev-parse', 'HEAD'),
      git(root, 'write-tree'),
      git(root, 'status', '--porcelain'),
      git(root, 'show-ref', '--heads'),
      'unstaged\n',
    ]);
  }
  if (kind === 'postgres') {
    roots.fill(process.cwd());
    if (process.env.TIMEY_STORE_TEST_BOOTSTRAP === '1') await ensureFactoryDatabase({ root: process.cwd() });
    t.after(async () => {
      const pool = createFactoryPool({}, { root: process.cwd() });
      try {
        await pool.query('DELETE FROM factory.store_operations WHERE project_id=$1', [projectId]);
        await pool.query('DELETE FROM factory.store_records WHERE project_id=$1', [projectId]);
      } finally {
        await pool.end();
      }
    });
  }
  if (kind === 'dynamodb') {
    config.region = process.env.TIMEY_STORE_DYNAMODB_REGION || 'eu-central-1';
    config.table = process.env.TIMEY_STORE_DYNAMODB_TABLE || `timey-store-test-${randomUUID()}`;
    assert.match(config.table, /^timey-store-test-/, 'Remote contracts require an isolated test table.');
    const client = new DynamoDBClient({ region: config.region });
    if (!process.env.TIMEY_STORE_DYNAMODB_TABLE) {
      assert.equal(process.env.TIMEY_STORE_DYNAMODB_CREATE, '1', 'Explicitly enable disposable DynamoDB provisioning.');
      await client.send(
        new CreateTableCommand({
          TableName: config.table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
        })
      );
      t.after(async () => {
        try {
          await client.send(new DeleteTableCommand({ TableName: config.table }));
          await waitUntilTableNotExists(
            { client, maxWaitTime: 60, minDelay: 1, maxDelay: 3 },
            { TableName: config.table }
          );
        } finally {
          client.destroy();
        }
      });
      await waitUntilTableExists({ client, maxWaitTime: 60, minDelay: 1, maxDelay: 3 }, { TableName: config.table });
    } else t.after(() => client.destroy());
  }
  const opened = [];
  const open = async (index = 0, extra = {}) => {
    const records = await openRecordStore({ ...config, ...extra }, { root: roots[index], projectId, artifacts });
    opened.push(records);
    return records;
  };
  t.after(async () => {
    for (const records of opened) await records.close();
  });
  return {
    config,
    roots,
    projectId,
    artifacts,
    open,
    async checkSource() {
      if (!unchanged) return;
      for (const [index, root] of roots.entries())
        assert.deepEqual(
          [
            git(root, 'rev-parse', 'HEAD'),
            git(root, 'write-tree'),
            git(root, 'status', '--porcelain'),
            git(root, 'show-ref', '--heads'),
            await readFile(join(root, 'source.txt'), 'utf8'),
          ],
          unchanged[index]
        );
    },
  };
}

for (const kind of providers)
  test(`${kind}: shared record and issue contract`, async (t) => {
    assert.ok(['files', 'git', 'postgres', 'dynamodb'].includes(kind));
    const f = await fixture(t, kind);
    const one = await f.open();
    const two = await f.open(1);
    assert.equal(await one.get('missing'), null);
    assert.deepEqual(await one.list(''), []);
    const first = {
      operationId: 'create',
      expected: [
        { key: 'a', revision: null },
        { key: 'b', revision: null },
      ],
      writes: [
        { key: 'a', value: { second: 2, first: 1 } },
        { key: 'b', value: ['preserved'] },
      ],
    };
    const created = await one.commit(first);
    assert.equal(created.records.length, 2);
    assert.deepEqual((await two.get('a')).value, { first: 1, second: 2 });
    assert.deepEqual(
      await two.commit({
        ...first,
        writes: [
          { key: 'b', value: ['preserved'] },
          { key: 'a', value: { first: 1, second: 2 } },
        ],
      }),
      created
    );
    await assert.rejects(
      () => two.commit({ ...first, writes: [{ key: 'a', value: 'changed' }] }),
      fails('STORE_OPERATION_MISMATCH')
    );
    await assert.rejects(
      () => one.commit({ operationId: 'bad', expected: [], writes: [{ key: 'unbound', value: 1 }] }),
      fails('STORE_INVALID')
    );
    await assert.rejects(
      () =>
        one.commit({
          operationId: 'undefined',
          expected: [{ key: 'u', revision: null }],
          writes: [{ key: 'u', value: { missing: undefined } }],
        }),
      fails('STORE_INVALID')
    );
    await assert.rejects(
      () =>
        one.commit({
          operationId: 'stale-multi',
          expected: [
            { key: 'a', revision: null },
            { key: 'partial', revision: null },
          ],
          writes: [
            { key: 'a', value: 'wrong' },
            { key: 'partial', value: true },
          ],
        }),
      fails('STORE_CONFLICT')
    );
    assert.equal(await two.get('partial'), null);
    const initialA = await one.get('a');
    await two.commit({
      operationId: 'update-a',
      expected: [{ key: 'a', revision: initialA.revision }],
      writes: [{ key: 'a', value: 3 }],
    });
    assert.deepEqual(
      await one.commit(first),
      created,
      'An old operation returns its original receipt after later writes.'
    );
    assert.equal((await two.get('a')).value, 3);
    if (one.readSnapshot) {
      await one.readSnapshot(async (pinned) => {
        const before = await pinned.get('a');
        const copied = await pinned.get('b');
        copied.value.push('caller mutation');
        assert.deepEqual((await pinned.get('b')).value, ['preserved']);
        await two.commit({
          operationId: 'during-pinned-read',
          expected: [{ key: 'a', revision: before.revision }],
          writes: [{ key: 'a', value: 3 }],
        });
        assert.equal((await pinned.get('a')).revision, before.revision);
        assert.notEqual((await one.get('a')).revision, before.revision);
      });
    }
    await assert.rejects(
      () =>
        one.commit({
          operationId: 'read-dependency',
          expected: [
            { key: 'a', revision: initialA.revision },
            { key: 'dependent', revision: null },
          ],
          writes: [{ key: 'dependent', value: 'must not land' }],
        }),
      fails('STORE_CONFLICT')
    );
    assert.equal(await two.get('dependent'), null);

    await Promise.all(
      [one, two].map((store, i) =>
        store.commit({
          operationId: `unrelated-${i}`,
          expected: [{ key: `unrelated/${i}`, revision: null }],
          writes: [{ key: `unrelated/${i}`, value: i }],
        })
      )
    );
    assert.equal((await one.list('unrelated/')).length, 2, 'Concurrent unrelated commits preserve both records.');

    const race = await Promise.allSettled(
      [one, two].map((store, i) =>
        store.commit({
          operationId: `racer-${i}`,
          expected: [{ key: 'claim', revision: null }],
          writes: [{ key: 'claim', value: { owner: i } }],
        })
      )
    );
    assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(race.find((item) => item.status === 'rejected').reason.code, 'STORE_CONFLICT');
    const claim = await one.get('claim');
    const release = {
      operationId: 'release',
      expected: [{ key: 'claim', revision: claim.revision }],
      writes: [{ key: 'claim', value: null }],
    };
    assert.deepEqual((await one.commit(release)).records, []);
    await two.commit({
      operationId: 'replacement',
      expected: [{ key: 'claim', revision: null }],
      writes: [{ key: 'claim', value: 'new owner' }],
    });
    await one.commit(release);
    assert.equal((await two.get('claim')).value, 'new owner');
    await assert.rejects(() => one.commit({ ...release, operationId: 'delayed-release' }), fails('STORE_CONFLICT'));
    const payload = { beginning: 'retained', content: 'x'.repeat(750_000), ending: 'retained' };
    await one.commit({
      operationId: 'large',
      expected: [{ key: 'large', revision: null }],
      writes: [{ key: 'large', value: payload }],
    });
    assert.deepEqual((await two.get('large')).value, payload);
    const replayLarge = await two.commit({
      operationId: 'large',
      expected: [{ key: 'large', revision: null }],
      writes: [{ key: 'large', value: payload }],
    });
    assert.deepEqual(replayLarge.records[0].value, payload);
    const receiptBatch = {
      operationId: 'large-receipt',
      expected: Array.from({ length: 20 }, (_, i) => ({ key: `batch/${i}`, revision: null })),
      writes: Array.from({ length: 20 }, (_, i) => ({ key: `batch/${i}`, value: 'y'.repeat(10_000) })),
    };
    const batchResult = await one.commit(receiptBatch);
    assert.equal(batchResult.records.length, 20);
    assert.deepEqual(await two.commit(receiptBatch), batchResult);
    const namespace = await f.open(0, { id: f.config.id + '-isolated' });
    assert.equal(await namespace.get('a'), null);
    const reopened = await f.open();
    assert.equal((await reopened.get('a')).value, 3);
    const lostReply = {
      operationId: 'reply-lost-after-commit',
      expected: [{ key: 'lost-reply', revision: null }],
      writes: [{ key: 'lost-reply', value: { retained: true } }],
    };
    await one.commit(lostReply);
    const recovered = await reopened.commit(lostReply);
    assert.deepEqual(
      recovered.records[0],
      await two.get('lost-reply'),
      'A fresh client recovers the landed operation after its original reply was discarded.'
    );
    const issues = await openIssueStore(f.config, { root: f.roots[0], projectId: f.projectId, artifacts: f.artifacts });
    t.after(() => issues.close());
    const report = Buffer.from('\uFEFF---\r\nid: test-issue\r\nunknown: kept\r\n---\r\n# Exact bytes\r\n');
    const issueRequest = {
      issueId: 'test-issue',
      expectedRevision: null,
      operationId: 'issue-create',
      report,
      location: 'open',
    };
    const original = await issues.commit(issueRequest);
    assert.deepEqual(original.report, report);
    const closed = await issues.commit({
      ...issueRequest,
      operationId: 'issue-close',
      expectedRevision: original.revision,
      location: 'closed',
    });
    assert.deepEqual(await issues.commit(issueRequest), original);
    assert.equal((await issues.read('test-issue')).revision, closed.revision);
    assert.deepEqual(
      (await issues.history('test-issue')).map((item) => item.location),
      ['open', 'closed']
    );
    assert.deepEqual((await issues.history('test-issue'))[1].report, report);
    assert.equal((await issues.list({ location: 'closed' })).length, 1);
    assert.equal((await issues.list({ location: 'archive' })).length, 0);
    assert.equal(issues.id, f.config.id);
    const retainedIssues = await issues.retainedPayloads();
    const owned = (key) => key.startsWith('issues/test-issue/');
    await issues.removeRecords({
      operationId: 'delete-issue-records',
      expected: retainedIssues.records.filter(({ key }) => owned(key)).map(({ key, revision }) => ({ key, revision })),
    });
    await issues.retireReceipts({
      operationId: 'delete-issue-receipts',
      issueId: 'test-issue',
      deletionId: 'checked-delete',
      receipts: retainedIssues.receipts
        .filter((entry) => entry.records.some(({ key }) => owned(key)))
        .map(({ id, inputDigest, identity }) => ({ id, inputDigest, identity })),
    });
    assert.equal(await issues.read('test-issue'), null);
    assert.deepEqual(await issues.history('test-issue'), []);
    await assert.rejects(issues.commit(issueRequest), fails('STORE_DELETED'));
    await f.checkSource();
  });

test('Postgres rejects the installed application database without a connection or exposed credentials', async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://app:secret@localhost/timey_app?options=-csearch_path%3Dapp';
  try {
    assert.throws(
      () =>
        createFactoryPool(
          {
            connectionString: 'postgresql://factory:another-secret@localhost/timey_app?options=-csearch_path%3Dfactory',
          },
          { root: tmpdir() }
        ),
      (error) => error.code === 'STORE_INVALID' && !error.message.includes('secret')
    );
    assert.throws(
      () =>
        createFactoryPool(
          { connectionString: 'postgresql://factory:another-secret@localhost/postgres' },
          { root: tmpdir() }
        ),
      fails('STORE_INVALID')
    );
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

for (const kind of providers) {
  test(`${kind}: deletion roots include private payloads and retired replay cannot upload them again`, async (t) => {
    const f = await fixture(t, kind);
    const store = await f.open();
    const peer = await f.open(1);
    const publicRef = await f.artifacts.put({
      body: Buffer.from('Evidence shared by another issue.'),
      mediaType: 'text/plain',
    });
    const writes = [
      { key: 'flow/deleted', value: { output: 'x'.repeat(80_000), evidence: publicRef } },
      ...Array.from({ length: 3 }, (_, index) => ({ key: 'history/deleted/' + index, value: 'y'.repeat(8_000) })),
    ];
    const create = {
      operationId: 'retained-private-values',
      expected: writes.map(({ key }) => ({ key, revision: null })),
      writes,
    };
    const created = await store.commit(create);
    await store.commit({
      operationId: 'live-public-reference',
      expected: [{ key: 'flow/survivor', revision: null }],
      writes: [{ key: 'flow/survivor', value: { evidence: publicRef } }],
    });
    const retained = await store.retainedPayloads();
    const source = retained.receipts.find((entry) => entry.records.some(({ key }) => key === 'flow/deleted'));
    assert.ok(source);
    assert.ok(source.refs.some((ref) => ref.sha256 === publicRef.sha256));
    assert.ok(
      source.refs.length >= 3,
      'Both the packed record and packed receipt result must be retained, alongside public evidence.'
    );
    assert.ok(retained.records.find(({ key }) => key === 'flow/deleted').refs.length >= 2);
    assert.equal(source.records.find(({ key }) => key === 'flow/deleted').value.output.length, 80_000);
    assert.equal(store.id, f.config.id);
    await store.removeRecords({
      operationId: 'remove-deleted-records',
      expected: created.records.map(({ key, revision }) => ({ key, revision })),
    });
    const selected = { id: source.id, inputDigest: source.inputDigest, identity: source.identity };
    await assert.rejects(
      store.retireReceipts({
        operationId: 'stale-cleanup',
        issueId: 'deleted',
        deletionId: 'delete-confirmed',
        receipts: [{ ...selected, identity: '0'.repeat(64) }],
      }),
      fails('STORE_CONFLICT')
    );
    const retirement = {
      operationId: 'retire-deleted-receipt',
      issueId: 'deleted',
      deletionId: 'delete-confirmed',
      receipts: [selected],
    };
    const result = await store.retireReceipts(retirement);
    assert.deepEqual(result.retired, [source.id]);
    assert.deepEqual(await peer.retireReceipts(retirement), result);
    const after = await peer.retainedPayloads();
    assert.deepEqual(after.receipts.find(({ id }) => id === source.id).refs, []);
    assert.ok(
      after.records.find(({ key }) => key === 'flow/survivor').refs.some((ref) => ref.sha256 === publicRef.sha256)
    );
    assert.deepEqual(
      after.records.map(({ key }) => key),
      ['flow/survivor']
    );
    const put = f.artifacts.put;
    let uploads = 0;
    f.artifacts.put = async (input) => {
      uploads++;
      return put(input);
    };
    await assert.rejects(peer.commit(create), fails('STORE_DELETED'));
    await assert.rejects(
      peer.commit({ ...create, writes: [{ key: writes[0].key, value: 'different payload' }] }),
      fails('STORE_OPERATION_MISMATCH')
    );
    assert.equal(uploads, 0, 'A retired replay must fail before packing or uploading old bytes.');
    assert.equal(await store.get('flow/deleted'), null);
    await f.checkSource();
  });

  test(`${kind}: retention excludes only verified self-inventory when explicitly requested`, async (t) => {
    const f = await fixture(t, kind);
    const store = await f.open();
    const body = Buffer.from('An artifact inventory body.');
    const ref = {
      storeId: f.config.id,
      key: 'inventory/' + sha(body),
      sha256: sha(body),
      bytes: body.length,
      mediaType: 'text/plain',
    };
    const key = 'artifact/' + ref.sha256;
    await store.commit({
      operationId: 'artifact-own-put',
      expected: [{ key, revision: null }],
      writes: [{ key, value: { ref, body: body.toString('base64') } }],
    });
    const unrelated = 'artifact/' + sha('not-an-inventory-key');
    await store.commit({
      operationId: 'ordinary-reference',
      expected: [{ key: unrelated, revision: null }],
      writes: [{ key: unrelated, value: { ref, body: body.toString('base64') } }],
    });
    const all = await store.retainedPayloads();
    assert.equal(all.records.length, 2);
    assert.equal(all.receipts.length, 2);
    const roots = await store.retainedPayloads({ excludeArtifactInventory: true });
    assert.deepEqual(
      roots.records.map(({ key }) => key),
      [unrelated]
    );
    assert.equal(roots.receipts.length, 1);
    assert.equal(roots.receipts[0].records[0].key, unrelated);
    assert.ok(roots.receipts[0].refs.some((item) => item.sha256 === ref.sha256));
    await f.checkSource();
  });
}

test('fresh Git writes return their acknowledged values without downloading the uploaded payload again', async (t) => {
  const f = await fixture(t, 'git');
  const store = await f.open();
  const get = f.artifacts.get.bind(f.artifacts);
  let downloads = 0;
  f.artifacts.get = async (ref) => {
    downloads++;
    return get(ref);
  };
  const value = { text: 'large payload'.repeat(5000) };
  const request = {
    operationId: 'fresh-large',
    expected: [{ key: 'value', revision: null }],
    writes: [{ key: 'value', value }],
  };
  const result = await store.commit(request);
  assert.deepEqual(result.records[0].value, value);
  assert.equal(downloads, 0, 'A confirmed new write already has its exact canonical values.');
  assert.deepEqual((await store.get('value')).value, value);
  assert.ok(downloads > 0, 'Subsequent reads still verify retained artifact bytes.');
  const beforeReplay = downloads;
  assert.deepEqual(await store.commit(request), result);
  assert.ok(downloads > beforeReplay, 'Replayed receipts are read from retained storage.');
});

test('Git metadata transactions reuse verified payload bytes and expire them before the next action', async (t) => {
  const f = await fixture(t, 'git');
  const store = await f.open();
  const value = { text: 'immutable payload'.repeat(5000) };
  await store.commit({
    operationId: 'seed-payload',
    expected: [{ key: 'value', revision: null }],
    writes: [{ key: 'value', value }],
  });
  const get = f.artifacts.get.bind(f.artifacts);
  let downloads = 0;
  f.artifacts.get = async (ref) => {
    downloads++;
    return get(ref);
  };
  await store.transaction(async () => {
    const first = await store.get('value');
    first.value.text = 'caller edit';
    assert.deepEqual((await store.get('value')).value, value);
    assert.equal(downloads, 1);
  });
  f.artifacts.get = async () => {
    throw Error('Retained payload unavailable');
  };
  await assert.rejects(store.get('value'), /Retained payload unavailable/);
});

test('Git payload caching retries failed reads and does not leak into detached callbacks', async (t) => {
  const f = await fixture(t, 'git');
  const store = await f.open();
  await store.commit({
    operationId: 'payload-lifetime',
    expected: [{ key: 'value', revision: null }],
    writes: [{ key: 'value', value: { text: 'large'.repeat(5000) } }],
  });
  const get = f.artifacts.get.bind(f.artifacts);
  let downloads = 0;
  f.artifacts.get = async (ref) => {
    downloads++;
    if (downloads === 1) throw Error('Temporary payload failure');
    return get(ref);
  };
  const release = Promise.withResolvers();
  let detached;
  await store.transaction(async () => {
    await assert.rejects(store.get('value'), /Temporary payload failure/);
    assert.ok((await store.get('value')).value.text);
    detached = (async () => {
      await release.promise;
      return store.get('value');
    })();
  });
  f.artifacts.get = async () => {
    throw Error('Payload unavailable after completion');
  };
  release.resolve();
  await assert.rejects(detached, /Payload unavailable after completion/);
});

test('metadata phases reuse immutable payloads on file stores while still observing changed records', async (t) => {
  const f = await fixture(t, 'files');
  const store = await f.open();
  const peer = await f.open(1);
  const value = { text: 'first'.repeat(5000) };
  await store.commit({
    operationId: 'first',
    expected: [{ key: 'value', revision: null }],
    writes: [{ key: 'value', value }],
  });
  const get = f.artifacts.get.bind(f.artifacts);
  let downloads = 0;
  f.artifacts.get = async (ref) => {
    downloads++;
    return get(ref);
  };
  await runMetadataOperation({ records: store }, async () => {
    const first = await store.get('value');
    assert.deepEqual((await store.get('value')).value, value);
    assert.equal(downloads, 1);
    const next = { text: 'second'.repeat(5000) };
    await peer.commit({
      operationId: 'second',
      expected: [{ key: 'value', revision: first.revision }],
      writes: [{ key: 'value', value: next }],
    });
    assert.deepEqual((await store.get('value')).value, next);
  });
});

test('native record capacity retains ordinary flows without artifact I/O and still overflows larger values', async (t) => {
  const { openFilesRecords } = await import('./factory-ui/stores/providers/files.mjs');
  const { recordStore } = await import('./factory-ui/stores/providers/records.mjs');
  const f = await fixture(t, 'files');
  const backend = await openFilesRecords(
    { id: 'native', kind: 'files' },
    { root: f.roots[0], projectId: 'native-capacity' }
  );
  backend.inlineLimit = 1_048_576;
  const store = recordStore(backend, f.artifacts);
  const value = { text: 'flow'.repeat(60_000) };
  let downloads = 0;
  const get = f.artifacts.get.bind(f.artifacts);
  f.artifacts.get = async (ref) => {
    downloads++;
    return get(ref);
  };
  const input = {
    operationId: 'native',
    expected: [{ key: 'flow', revision: null }],
    writes: [{ key: 'flow', value }],
  };
  const saved = await store.commit(input);
  assert.deepEqual((await store.get('flow')).value, value);
  assert.deepEqual(await store.commit(input), saved);
  assert.equal(downloads, 0);
  const large = { text: 'flow'.repeat(300_000) };
  await store.commit({
    operationId: 'overflow',
    expected: [{ key: 'large', revision: null }],
    writes: [{ key: 'large', value: large }],
  });
  assert.deepEqual((await store.get('large')).value, large);
  assert.ok(downloads > 0);
  await store.close();
});
