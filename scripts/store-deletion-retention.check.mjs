import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsDeletedRecord, planRetirement, redactDeletedMove } from './factory-ui/stores/deletion-retention.mjs';

const ref = (name) => ({ storeId: 'evidence', key: name, sha256: name.repeat(64), bytes: 1 });
const record = (key, value = {}, refs = []) => ({ key, revision: 'saved-' + key, value, refs });
const receipt = (id, records, refs = []) => ({
  id,
  records,
  refs,
  inputDigest: 'digest-' + id,
  identity: 'identity-' + id,
});

test('permanent deletion matches exact issue scopes and preserves neighboring issue IDs and catalog authority', () => {
  const owned = [
    'issues/a/head',
    'issues/a/history/commit',
    'flows/a',
    'evidence/a',
    'classic/a',
    'progress/a/attempt',
    'commands/a/stop',
    'issue-history/a/move',
  ];
  const neighbors = [
    'issues/ab/head',
    'issues/a-long/history/commit',
    'flows/ab',
    'evidence/ba',
    'classic/ab',
    'progress/ab/attempt',
    'commands/ab/stop',
    'issue-history/ab/move',
    'private/a',
    'flows/a/unknown',
  ];
  const catalog = record('catalog/a', { storeId: 'primary', state: 'archived' });
  const snapshot = {
    records: [...owned, ...neighbors].map((key) => record(key)).concat(catalog),
    receipts: [receipt('old-catalog', [catalog])],
  };
  const plan = planRetirement(snapshot, 'a');
  assert.deepEqual(
    plan.records.map(({ key }) => key),
    owned
  );
  assert.deepEqual(
    plan.receipts.map(({ id }) => id),
    ['old-catalog']
  );
  assert.equal(
    ownsDeletedRecord(catalog, 'a'),
    true,
    'The old catalog payload qualifies its receipt without removing current routing authority.'
  );
  for (const key of neighbors) assert.equal(ownsDeletedRecord(record(key), 'a'), false, key);
});

test('mixed backend receipts are retired while mixed domain history remains retained for surviving issues', () => {
  const a = record('flows/a', { evidence: ref('a') }, [ref('a')]);
  const b = record('flows/b', { evidence: ref('b') }, [ref('b')]);
  const mixed = record(
    'operations/group-move',
    {
      kind: 'move-issue',
      input: { ids: ['a', 'b'] },
      sources: [
        { id: 'a', storeId: 'old' },
        { id: 'b', storeId: 'old' },
      ],
    },
    [ref('a'), ref('b')]
  );
  const exclusive = record('operations/a-move', {
    kind: 'move-issue',
    input: { ids: ['a'] },
    sources: [{ id: 'a', storeId: 'old' }],
  });
  const unrelated = record('operations/other', { kind: 'save-issue', input: { issueId: 'ab' }, notes: 'a' });
  const plan = planRetirement(
    {
      records: [a, b, mixed, exclusive, unrelated],
      receipts: [
        receipt('mixed-batch', [a, b], [ref('a'), ref('b')]),
        receipt('group-history', [mixed], [ref('a'), ref('b')]),
        receipt('b-only', [b], [ref('b')]),
      ],
    },
    'a'
  );
  assert.deepEqual(
    plan.records.map(({ key }) => key),
    ['flows/a', 'operations/a-move']
  );
  assert.deepEqual(
    plan.receipts.map(({ id }) => id),
    ['mixed-batch', 'group-history']
  );
  assert.deepEqual(
    plan.refs,
    [ref('a'), ref('b')],
    'The final global retained-root scan decides which mixed candidates remain live.'
  );
  assert.equal(
    plan.values.some((value) => value === b.value),
    false
  );
  assert.equal(ownsDeletedRecord(mixed, 'a'), true);
  assert.equal(ownsDeletedRecord(mixed, 'b'), true);
});

test('the current deletion operation and its pending plan cannot classify or retain themselves as obsolete payloads', () => {
  const current = record(
    'operations/delete-a',
    { kind: 'delete-issue', input: { issueId: 'a' }, cleanup: { phase: 'pending', evidence: ref('c') } },
    [ref('c')]
  );
  const flow = record('flows/a', { evidence: ref('a') }, [ref('a')]);
  const plan = planRetirement(
    {
      records: [current, flow],
      receipts: [receipt('current-plan', [current], [ref('c')]), receipt('old-flow', [flow], [ref('a')])],
    },
    'a',
    { operationKey: current.key }
  );
  assert.deepEqual(
    plan.records.map(({ key }) => key),
    ['flows/a']
  );
  assert.deepEqual(
    plan.receipts.map(({ id }) => id),
    ['old-flow']
  );
  assert.deepEqual(plan.refs, [ref('a')]);
  assert.deepEqual(plan.values, [flow.value, flow.value]);
});

test('confirmed mixed issue moves redact only deleted sources while preserving replay identity and survivor history', () => {
  const sourceA = { id: 'a', storeId: 'old', report: 'Deleted request', history: [{ proof: ref('a') }] };
  const sourceB = { id: 'b', storeId: 'old', report: 'Surviving request', history: [{ proof: ref('b') }] };
  const move = record(
    'operations/shared-move',
    {
      id: 'shared-move',
      kind: 'move-issue',
      status: 'confirmed',
      inputHash: 'immutable-original-digest',
      input: { ids: ['a', 'b'], storeId: 'new' },
      sources: [sourceA, sourceB],
      deletedIssueIds: [],
    },
    [ref('a'), ref('b')]
  );
  const value = redactDeletedMove(move, 'a');
  assert.equal(value.inputHash, move.value.inputHash);
  assert.equal(value.id, move.value.id);
  assert.equal(value.status, 'confirmed');
  assert.deepEqual(value.input, move.value.input);
  assert.deepEqual(value.sources, [sourceB]);
  assert.deepEqual(value.deletedIssueIds, ['a']);
  assert.deepEqual(move.value.sources, [sourceA, sourceB], 'Planning cannot mutate stored history.');
  const plan = planRetirement({ records: [move], receipts: [] }, 'a');
  assert.deepEqual(plan.records, []);
  assert.deepEqual(plan.replacements, [{ key: move.key, revision: move.revision, value }]);
  assert.deepEqual(plan.values, [sourceA]);
  assert.deepEqual(plan.refs, [ref('a'), ref('b')]);
  const redacted = record(move.key, value, [ref('b')]);
  assert.equal(redactDeletedMove(redacted, 'a'), null);
  assert.equal(ownsDeletedRecord(redacted, 'a'), false);
  assert.equal(ownsDeletedRecord(redacted, 'b'), true);
  assert.deepEqual(planRetirement({ records: [redacted], receipts: [] }, 'b').records, [
    { key: move.key, revision: move.revision },
  ]);
  for (const excluded of [
    { ...move, key: 'private/move' },
    { ...move, value: { ...move.value, kind: 'move-project-store' } },
    { ...move, value: { ...move.value, status: 'pending' } },
    { ...move, value: { ...move.value, sources: [sourceA] } },
  ])
    assert.equal(redactDeletedMove(excluded, 'a'), null);
});
