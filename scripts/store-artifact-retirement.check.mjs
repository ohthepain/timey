import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { openRecordStore } from './factory-ui/stores/providers.mjs';

test('Git Artifact Delete retires current receipt bodies and blocks replay without affecting another object', async (t) => {
  const f = gitFixture(t, 'git-artifact-delete-');
  f.git('commit', '--allow-empty', '-qm', 'Source remains unchanged');
  const head = f.git('rev-parse', 'HEAD');
  const remote = join(f.root, 'objects.git');
  f.git('init', '--bare', '-q', remote);
  f.git('remote', 'add', 'origin', remote);
  const config = { id: 'objects', kind: 'git', remote: 'origin', branch: 'issue-artifacts' };
  const options = { root: f.root, projectId: 'delete-contract' };
  const store = await openArtifactStore(config, options);
  const privatePayloads = await openArtifactStore({ id: 'private-payloads', kind: 'files' }, options);
  const canonical = await openRecordStore(config, { ...options, artifacts: privatePayloads });
  t.after(() => canonical.close());
  t.after(() => store.close());
  const commit = store.records.commit;
  const commands = [];
  store.records.commit = function (input) {
    commands.push(structuredClone(input));
    return commit.call(this, input);
  };
  const body = Buffer.from('Delete these unique evidence bytes. '.repeat(700));
  const keptBody = Buffer.from('Another issue still needs its evidence.');
  const deleted = await store.put({ body });
  const original = commands[0];
  const kept = await store.put({ body: keptBody });
  const otherOutput = 'Other issue private packed output. '.repeat(1000);
  await canonical.commit({
    operationId: 'other-large-record',
    expected: [{ key: 'flow/other-issue', revision: null }],
    writes: [{ key: 'flow/other-issue', value: { output: otherOutput } }],
  });
  await store.get(deleted);
  await store.remove(deleted);
  const current = JSON.stringify(await canonical.retainedPayloads());
  assert.ok(
    !current.includes(body.toString('base64')),
    'Deleted bytes must leave current records and permanent operation receipts.'
  );
  assert.deepEqual(await store.get(kept), keptBody);
  await assert.rejects(store.records.commit(original), { code: 'STORE_DELETED' });
  assert.equal(await store.inspect(deleted), null);
  await store.remove(deleted);
  const reuploaded = await store.put({ body });
  assert.deepEqual(await store.get(reuploaded), body);
  await store.remove(reuploaded);
  assert.ok(!JSON.stringify(await canonical.retainedPayloads()).includes(body.toString('base64')));
  assert.deepEqual(await store.get(kept), keptBody);
  assert.equal((await canonical.get('flow/other-issue')).value.output, otherOutput);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});
