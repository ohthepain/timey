import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordStore } from './factory-ui/stores/providers.mjs';
import { gitFixture } from './git-fixture.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(t) {
  const { root, git } = gitFixture(t, 'timey-git-transaction-');
  writeFileSync(join(root, 'source.txt'), 'Source\n');
  git('add', '.');
  git('commit', '-qm', 'Initial source');
  git('remote', 'add', 'origin', root);
  const open = () =>
    openRecordStore({ id: 'git', kind: 'git', branch: 'queue' }, { root, projectId: 'fixture', inlinePayloads: true });
  const owner = await open();
  const peer = await open();
  const write = (store, id, key, value, revision = null) =>
    store.commit({
      operationId: id,
      expected: [{ key, revision }],
      writes: [{ key, value }],
    });
  return { owner, peer, write, git, root, open };
}

test('Git transaction publishes its records and replay receipts together after the callback', async (t) => {
  const { owner, peer, write, git } = await fixture(t);
  let first;
  await owner.transaction(async () => {
    first = await write(owner, 'first', 'value', 'one');
    assert.equal(await peer.get('value'), null);
    assert.equal((await owner.get('value')).value, 'one');
    await write(owner, 'second', 'value', 'two', first.records[0].revision);
    assert.equal((await owner.list('value'))[0].value, 'two');
    assert.equal((await write(owner, 'first', 'value', 'one')).records[0].value, 'one');
  });
  assert.equal((await peer.get('value')).value, 'two');
  assert.equal(git('rev-list', '--count', 'queue'), '1', 'All metadata changes use one published commit.');
  assert.deepEqual(await write(peer, 'first', 'value', 'one'), first);
});

test('Git transaction rolls back all buffered records and receipts on a callback failure', async (t) => {
  const { owner, peer, write } = await fixture(t);
  await assert.rejects(
    owner.transaction(async () => {
      await write(owner, 'aborted', 'value', 'unpublished');
      throw Error('Stop before publication');
    }),
    /Stop before publication/
  );
  assert.equal(await peer.get('value'), null);
  await write(peer, 'aborted', 'value', 'new input');
  assert.equal((await owner.get('value')).value, 'new input');
});

test('Git transaction rejects a peer update without overwriting it or publishing partial results', async (t) => {
  const { owner, peer, write } = await fixture(t);
  const seed = await write(peer, 'seed', 'existing', 'original');
  await assert.rejects(
    owner.transaction(async () => {
      await owner.get('existing');
      await write(owner, 'unpublished', 'local', 'ours');
      await write(peer, 'peer', 'existing', 'theirs', seed.records[0].revision);
    }),
    { code: 'STORE_CONFLICT' }
  );
  assert.equal(await peer.get('local'), null);
  assert.equal((await owner.get('existing')).value, 'theirs');
  await write(peer, 'unpublished', 'local', 'retry input');
});

test('Git transaction keeps snapshots pinned and invalidates detached descendants at completion', async (t) => {
  const { owner, peer, write } = await fixture(t);
  const release = Promise.withResolvers();
  let detached;
  await owner.transaction(async () => {
    const first = await write(owner, 'first', 'value', 'first');
    await owner.readSnapshot(async (pinned) => {
      await write(owner, 'second', 'value', 'second', first.records[0].revision);
      assert.equal((await pinned.get('value')).value, 'first');
    });
    detached = (async () => {
      await release.promise;
      return (await owner.get('value')).value;
    })();
  });
  const current = await peer.get('value');
  await write(peer, 'third', 'value', 'peer', current.revision);
  release.resolve();
  assert.equal(await detached, 'peer');
});

test('Git transaction validates staged revisions and removes records from subsequent reads', async (t) => {
  const { owner, peer, write } = await fixture(t);
  await owner.transaction(async () => {
    const first = await write(owner, 'first', 'value', 'first');
    await assert.rejects(write(owner, 'stale', 'value', 'wrong'), { code: 'STORE_CONFLICT' });
    await write(owner, 'remove', 'value', null, first.records[0].revision);
    assert.equal(await owner.get('value'), null);
    assert.deepEqual(await owner.list(''), []);
  });
  assert.equal(await peer.get('value'), null);
});

test('Git transaction reconciles a successful publication whose push reply is lost', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'bin');
  mkdirSync(directory);
  const executable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(directory, 'git'),
    '#!/bin/sh\n' +
      JSON.stringify(executable) +
      ' "$@"\nresult=$?\nif [ "$result" -eq 0 ]; then\n  for arg in "$@"; do\n    if [ "$arg" = push ]; then exit 1; fi\n  done\nfi\nexit "$result"\n',
    { mode: 0o755 }
  );
  const previous = process.env.PATH;
  let owner;
  try {
    process.env.PATH = directory + ':' + previous;
    owner = await f.open();
  } finally {
    process.env.PATH = previous;
  }
  await owner.transaction(async () => {
    await f.write(owner, 'one', 'one', 'one');
    await f.write(owner, 'two', 'two', 'two');
  });
  assert.equal((await f.peer.get('one')).value, 'one');
  assert.equal((await f.peer.get('two')).value, 'two');
  assert.equal(f.git('rev-list', '--count', 'queue'), '1');
});

test('Git transaction preserves unrelated peer writes without replaying its callback', async (t) => {
  const { owner, peer, write } = await fixture(t);
  let executions = 0;
  await owner.transaction(async () => {
    executions++;
    await owner.readSnapshot((pinned) => pinned.list('commands/ours/'));
    await write(owner, 'ours', 'flows/ours', 'ours');
    await write(peer, 'theirs', 'flows/theirs', 'theirs');
  });
  assert.equal(executions, 1);
  assert.equal((await owner.get('flows/ours')).value, 'ours');
  assert.equal((await owner.get('flows/theirs')).value, 'theirs');
});

test('Git transaction rejects a new command in a prefix read before publication', async (t) => {
  const { owner, peer, write } = await fixture(t);
  await assert.rejects(
    owner.transaction(async () => {
      await owner.readSnapshot((pinned) => pinned.list('commands/ours/'));
      await write(owner, 'ours', 'flows/ours', 'finished');
      await write(peer, 'stop', 'commands/ours/stop', 'stop');
    }),
    { code: 'STORE_CONFLICT' }
  );
  assert.equal(await owner.get('flows/ours'), null);
  assert.equal((await owner.get('commands/ours/stop')).value, 'stop');
});
