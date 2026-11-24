import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { readOwnership, recoverOwnership, cancelPendingFlowSave } from './factory-ui/stores/recovery.mjs';
import { handleStoreAction } from './factory-ui/stores/routes.mjs';
import { sealCoordination } from './factory-ui/stores/coordination.mjs';
import { registerProjectStores } from './factory-ui/stores/report-access.mjs';
import { FlowStore } from './factory-ui/flow-store.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-explicit-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, projectId: 'recovery-fixture' };
  const artifacts = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  const records = await openRecordStore({ id: 'coordination', kind: 'files' }, { ...options, artifacts });
  const issues = await openIssueStore({ id: 'issues', kind: 'files' }, { ...options, artifacts });
  const make = (runnerId) =>
    createProjectStores({ ...options, runnerId, records, artifacts, issueStores: new Map([['issues', issues]]) });
  const stores = make('original-runner');
  const id = '20261122-recovery';
  await stores.importIssue({
    id,
    number: 1,
    storeId: 'issues',
    operationId: 'import',
    report: `---\nid: ${id}\ntitle: Shared recovery\nstate: backlog\n---\n\nOriginal report.\n`,
    flow: {
      version: 1,
      issueId: id,
      revision: 1,
      blocks: [
        { id: 'request', kind: 'request', attempts: [], after: [] },
        { id: 'work', kind: 'work', attempts: [], after: ['request'] },
        { id: 'merge', kind: 'merge', attempts: [], after: ['work'] },
      ],
    },
  });
  const { owner } = await stores.beginAttempt({
    issueId: id,
    blockId: 'work',
    attempt: { id: 'abandoned' },
    expectedRevision: 1,
    operationId: 'admit',
  });
  const other = make('operator-runner');
  await other.refresh();
  const service = {
    root,
    projectStores: other,
    flows: { active: new Map() },
    ownServer() {
      this.authorizations = (this.authorizations || 0) + 1;
    },
  };
  const input = {
    issueId: id,
    attemptId: owner.attemptId,
    runnerId: owner.runnerId,
    ownerToken: owner.token,
    operationId: 'recover-abandoned',
    confirmed: true,
    reason: 'The original runner was stopped and external operations were checked.',
  };
  return { root, records, stores, other, id, owner, service, input };
}

void test('confirmed ownership recovery preserves pending evidence without shadowing the recovered flow', async (t) => {
  const f = await fixture(t);
  t.after(registerProjectStores(f.root, f.other));
  const store = new FlowStore(f.root, { ownerForIssue: () => f.owner });
  f.service.flows.store = store;
  const flow = structuredClone((await f.other.readIssue(f.id)).flow);
  flow.blocks[1].attempts[0].output = 'Earlier publication';
  store.stage(flow);
  store.flowPublication(f.id);
  flow.blocks[1].attempts[0].output = 'Newest unpublished progress';
  store.stage(flow);
  await readOwnership(f.service, { issueId: f.id });
  assert.ok(store.pendingFlow(f.id), 'Reading ownership must not discard unrecovered progress.');
  await recoverOwnership(f.service, f.input);
  assert.equal(store.pendingFlow(f.id), undefined, 'Recovered progress must not shadow the authoritative revision.');
  const directory = join(f.root, '.issues/store-runtime/recovered-flows', f.id);
  const [path] = readdirSync(directory);
  const evidence = JSON.parse(readFileSync(join(directory, path), 'utf8'));
  assert.equal(evidence.pending.flow.blocks[1].attempts[0].output, 'Newest unpublished progress');
  assert.equal(evidence.publication.flow.blocks[1].attempts[0].output, 'Earlier publication');
  assert.equal(evidence.recovery.value.status, 'confirmed');
  const recovered = (await f.other.readIssue(f.id)).flow;
  assert.equal(recovered.blocks[1].attempts[0].status, 'uncertain');
  await assert.rejects(store.save(recovered, recovered.revision), { code: 'STORE_NOT_OWNER' });
  store.ownerForIssue = () => undefined;
  recovered.blocks[1].comments = [{ text: 'A new operator edit after recovery.' }];
  await store.save(recovered, recovered.revision);
});

void test('a restarted store reconciles confirmed recovery but preserves a different pending owner', async (t) => {
  const f = await fixture(t);
  t.after(registerProjectStores(f.root, f.other));
  const store = new FlowStore(f.root, { ownerForIssue: () => f.owner });
  const flow = (await f.other.readIssue(f.id)).flow;
  store.stage(flow);
  await f.other.recoverAttempt({ ...f.input, operationId: 'ownership-recovery-' + f.input.operationId });
  await f.other.refresh();
  const restarted = new FlowStore(f.root, { ownerForIssue: () => ({ ...f.owner, token: 'replacement-token' }) });
  f.service.flows.store = restarted;
  await readOwnership(f.service, { issueId: f.id });
  assert.equal(restarted.pendingFlow(f.id), undefined);
  restarted.stage(flow);
  await readOwnership(f.service, { issueId: f.id });
  assert.equal(restarted.pendingFlow(f.id).owner.token, 'replacement-token');
});

test('ownership reads never expire old claims and require explicit stopped-runner confirmation', async (t) => {
  const f = await fixture(t);
  const claim = await f.records.get('claims/' + f.id);
  await f.records.commit({
    operationId: 'old-claim-time',
    expected: [{ key: claim.key, revision: claim.revision }],
    writes: [{ key: claim.key, value: { ...claim.value, acquiredAt: '1900-01-01T00:00:00.000Z' } }],
  });
  const view = await readOwnership(f.service, { issueId: f.id });
  assert.equal(f.service.authorizations, undefined);
  assert.equal(view.authoritative, true);
  assert.equal(view.ownership.ownerToken, f.owner.token);
  assert.equal(view.ownership.acquiredAt, '1900-01-01T00:00:00.000Z');
  assert.equal(view.canRecover, true);
  await assert.rejects(recoverOwnership(f.service, { ...f.input, confirmed: false }), {
    code: 'STORE_RECOVERY_CONFIRMATION',
  });
  await assert.rejects(recoverOwnership(f.service, { ...f.input, reason: '' }), {
    code: 'STORE_RECOVERY_CONFIRMATION',
  });
  assert.equal((await f.records.get(claim.key)).value.token, f.owner.token);
});

test('recovery binds exact runner, attempt and token, fences late finish, and preserves a replacement claim on replay', async (t) => {
  const f = await fixture(t);
  await assert.rejects(recoverOwnership(f.service, { ...f.input, runnerId: 'different-runner' }), {
    code: 'STORE_NOT_OWNER',
  });
  await assert.rejects(recoverOwnership(f.service, { ...f.input, attemptId: 'different-attempt' }), {
    code: 'STORE_NOT_OWNER',
  });
  await assert.rejects(recoverOwnership(f.service, { ...f.input, ownerToken: 'old-token' }), {
    code: 'STORE_NOT_OWNER',
  });
  const recovered = await recoverOwnership(f.service, f.input);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.ownership, null);
  const flow = (await f.other.readIssue(f.id)).flow;
  assert.equal(flow.blocks[1].attempts[0].status, 'uncertain');
  assert.ok(flow.blocks[1].attempts[0].reconciledAt);
  const next = await f.other.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'replacement' },
    expectedRevision: flow.revision,
    operationId: 'admit-replacement',
  });
  await assert.rejects(recoverOwnership(f.service, { ...f.input, operationId: 'delayed-stale-recovery' }), {
    code: 'STORE_NOT_OWNER',
  });
  const replay = await recoverOwnership(f.service, f.input);
  assert.equal(replay.ownership.ownerToken, next.owner.token);
  await assert.rejects(
    f.stores.finishAttempt(f.owner, { result: { status: 'completed' }, operationId: 'late-finish' }),
    { code: 'STORE_NOT_OWNER' }
  );
  assert.equal((await f.records.get('claims/' + f.id)).value.token, next.owner.token);
});

test('local active attempts and cached outage ownership cannot authorize recovery', async (t) => {
  const f = await fixture(t);
  f.service.flows.active.set(f.id, { storeOwner: f.owner });
  assert.equal((await readOwnership(f.service, { issueId: f.id })).canRecover, false);
  await assert.rejects(recoverOwnership(f.service, f.input), { code: 'STORE_ACTIVE_RUN' });
  f.service.flows.active.clear();
  await readOwnership(f.service, { issueId: f.id });
  f.service.storeStatus = { unavailable: true };
  const cached = await readOwnership(f.service, { issueId: f.id });
  assert.equal(cached.authoritative, false);
  assert.equal(cached.canRecover, false);
  assert.equal(cached.ownership.ownerToken, f.owner.token);
  await assert.rejects(recoverOwnership(f.service, f.input), { code: 'STORE_UNAVAILABLE' });
  assert.equal((await f.records.get('claims/' + f.id)).value.token, f.owner.token);
});

test('recovering stale ownership after merge preserves the entire merged flow and never restarts it', async (t) => {
  const f = await fixture(t);
  const record = await f.records.get('flows/' + f.id);
  const merged = { ...record.value, merged: { pr: 7, revision: 'a'.repeat(40) } };
  await f.records.commit({
    operationId: 'observed-external-merge',
    expected: [{ key: record.key, revision: record.revision }],
    writes: [{ key: record.key, value: merged }],
  });
  const recovered = await recoverOwnership(f.service, f.input);
  assert.equal(recovered.merged, true);
  assert.equal(recovered.canRestart, false);
  assert.deepEqual((await f.records.get(record.key)).value, merged);
  await assert.rejects(
    f.other.beginAttempt({
      issueId: f.id,
      blockId: 'work',
      attempt: { id: 'invalid-restart' },
      expectedRevision: merged.revision,
      operationId: 'invalid-merged-restart',
    }),
    { code: 'STORE_MERGED' }
  );
});

test('recovery resumes its original receipt after a lost reply without releasing a newer owner', async (t) => {
  const f = await fixture(t);
  const recover = f.other.recoverAttempt.bind(f.other);
  let dropped = false;
  f.other.recoverAttempt = async (input) => {
    const value = await recover(input);
    if (!dropped) {
      dropped = true;
      throw new Error('The confirmed recovery reply was lost.');
    }
    return value;
  };
  await assert.rejects(recoverOwnership(f.service, f.input), /reply was lost/);
  const flow = (await f.other.readIssue(f.id)).flow;
  const next = await f.other.beginAttempt({
    issueId: f.id,
    blockId: 'work',
    attempt: { id: 'replacement' },
    expectedRevision: flow.revision,
    operationId: 'replacement-after-lost-reply',
  });
  const view = await recoverOwnership(f.service, f.input);
  assert.equal(view.recovered, true);
  assert.equal(view.ownership.ownerToken, next.owner.token);
  await assert.rejects(
    recoverOwnership(f.service, { ...f.input, reason: 'Different explanation for the same operation.' }),
    { code: 'STORE_OPERATION_MISMATCH' }
  );
});

test('cached released ownership cannot authorize a restart during an outage', async (t) => {
  const f = await fixture(t);
  assert.equal((await recoverOwnership(f.service, f.input)).canRestart, true);
  f.service.storeStatus = { unavailable: true };
  const view = await readOwnership(f.service, { issueId: f.id });
  assert.equal(view.ownership, null);
  assert.equal(view.canRestart, false);
  assert.equal(view.canRecover, false);
});

test('manual recovery uses one atomic receipt and needs no second confirmation after releasing the claim', async (t) => {
  const f = await fixture(t);
  let secondConfirmation = 0;
  f.other.coordination.updateOperation = async () => {
    secondConfirmation++;
    throw Object.assign(Error('The connection failed after the atomic recovery.'), { code: 'STORE_UNAVAILABLE' });
  };
  await recoverOwnership(f.service, f.input);
  assert.equal(secondConfirmation, 0);
  const operations = await f.records.list('operations/');
  assert.equal(operations.filter((operation) => operation.value.kind === 'recover-attempt').length, 1);
  assert.equal(operations.filter((operation) => operation.value.status === 'pending').length, 0);
  assert.equal(await f.records.get('claims/' + f.id), null);
  assert.ok(
    await sealCoordination(f.other.coordination, {
      id: 'seal-after-recovery',
      role: 'coordination',
      storeId: 'destination',
      operationId: 'seal-after-recovery',
    })
  );
});

test('known atomic recovery conflicts become terminal receipts and cannot be finalized later', async (t) => {
  const f = await fixture(t);
  const finalize = f.other.coordination.finalize.bind(f.other.coordination);
  f.other.coordination.finalize = async () => {
    throw Object.assign(Error('The flow changed before atomic recovery.'), { code: 'STORE_CONFLICT' });
  };
  await assert.rejects(recoverOwnership(f.service, f.input), {
    code: 'STORE_CONFLICT',
    rejected: true,
    pending: false,
  });
  const operation = await f.records.get('operations/ownership-recovery-' + f.input.operationId);
  assert.equal(operation.value.status, 'rejected');
  assert.equal(operation.value.input.runnerId, f.owner.runnerId);
  assert.equal((await f.records.get('claims/' + f.id)).value.token, f.owner.token);
  f.other.coordination.finalize = finalize;
  await assert.rejects(finalize(operation, f.owner), { code: 'STORE_CONFLICT', rejected: true });
  await assert.rejects(recoverOwnership(f.service, f.input), { code: 'STORE_CONFLICT', rejected: true });
  await recoverOwnership(f.service, { ...f.input, operationId: 'new-recovery-after-conflict' });
  assert.equal((await f.records.list('operations/')).filter((entry) => entry.value.status === 'pending').length, 0);
});

test('unavailable recovery stays pending with its claim, while a confirmed lost reply resolves from the same receipt', async (t) => {
  const f = await fixture(t);
  const finalize = f.other.coordination.finalize.bind(f.other.coordination);
  let unavailable = true;
  f.other.coordination.finalize = async (...args) => {
    if (unavailable) throw Object.assign(Error('The store did not reply.'), { code: 'STORE_UNAVAILABLE' });
    const result = await finalize(...args);
    throw Object.assign(Error('The confirmed reply was lost.'), { code: 'STORE_UNAVAILABLE', result });
  };
  await assert.rejects(recoverOwnership(f.service, f.input), { code: 'STORE_UNAVAILABLE', pending: true });
  const key = 'operations/ownership-recovery-' + f.input.operationId;
  assert.equal((await f.records.get(key)).value.status, 'pending');
  assert.equal((await f.records.get('claims/' + f.id)).value.token, f.owner.token);
  unavailable = false;
  const recovered = await recoverOwnership(f.service, f.input);
  assert.equal(recovered.recovered, true);
  assert.equal((await f.records.get(key)).value.status, 'confirmed');
  assert.equal(await f.records.get('claims/' + f.id), null);
});

async function pendingPublication(t, claimed = true) {
  const f = await fixture(t);
  await recoverOwnership(f.service, f.input);
  const flow = await f.records.get('flows/' + f.id);
  const operation = await f.other.coordination.operation('pending-save', 'save-flow', {
    issueId: f.id,
    flow: { ...flow.value, closing: { resolution: 'fixed' } },
    expectedRevision: flow.value.revision,
    owner: null,
    purpose: 'closure',
  });
  if (claimed) await f.other.coordination.acquire(f.other.coordination.owner(operation, f.id), 'pending-claim');
  const claim = await f.records.get('claims/' + f.id);
  return {
    ...f,
    originalFlow: flow,
    operation,
    cancellation: {
      issueId: f.id,
      publicationId: 'pending-save',
      operationId: 'cancel-save',
      operationRevision: operation.revision,
      flowRevision: flow.revision,
      claimRevision: claim?.revision ?? null,
      confirmed: true,
      reason: 'Publication stopped; operator cancelled its uncommitted flow edit.',
    },
  };
}

void test('explicit publication cancellation retains input and current flow, releases only its claim, and fences replay', async (t) => {
  for (const claimed of [false, true]) {
    const f = await pendingPublication(t, claimed);
    assert.deepEqual(await cancelPendingFlowSave(f.service, f.cancellation), { cancelled: true });
    const operation = await f.records.get(f.operation.key);
    assert.equal(operation.value.status, 'rejected');
    assert.deepEqual(operation.value.input, f.operation.value.input);
    assert.deepEqual(await f.records.get('flows/' + f.id), f.originalFlow);
    assert.equal(await f.records.get('claims/' + f.id), null);
    assert.deepEqual(await cancelPendingFlowSave(f.service, f.cancellation), { cancelled: true });
    await assert.rejects(f.other.saveFlow({ ...f.operation.value.input, operationId: 'pending-save' }), {
      code: 'STORE_PUBLICATION_CANCELLED',
    });
  }
});

void test('publication cancellation rejects absent confirmation, local activity and changed authority', async (t) => {
  for (const variant of ['confirmation', 'active', 'revision', 'peer']) {
    const f = await pendingPublication(t);
    const input = { ...f.cancellation };
    if (variant === 'confirmation') input.confirmed = false;
    if (variant === 'active') f.service.flows.active.set(f.id, {});
    if (variant === 'revision') input.flowRevision = 'stale';
    if (variant === 'peer') {
      const claim = await f.records.get('claims/' + f.id);
      await f.records.commit({
        operationId: 'peer',
        expected: [{ key: claim.key, revision: claim.revision }],
        writes: [{ key: claim.key, value: { ...claim.value, token: 'peer' } }],
      });
      input.claimRevision = (await f.records.get(claim.key)).revision;
    }
    await assert.rejects(cancelPendingFlowSave(f.service, input));
    assert.equal((await f.records.get(f.operation.key)).value.status, 'pending');
    assert.deepEqual(await f.records.get('flows/' + f.id), f.originalFlow);
    assert.ok(await f.records.get('claims/' + f.id));
  }
});

void test('storage recovery reconciles only a superseded owner-bound save and keeps its history', async (t) => {
  const f = await fixture(t);
  const { flow } = await f.other.readIssue(f.id);
  const input = {
    issueId: f.id,
    flow,
    expectedRevision: flow.revision,
    owner: f.owner,
    purpose: 'edit',
  };
  const saved = await f.other.coordination.operation('stale-save', 'save-flow', input);
  const command = { action: 'reconcile-flow-save', operationId: 'stale-save' };
  await assert.rejects(handleStoreAction(f.service, command), { code: 'STORE_BUSY' });
  assert.equal((await f.records.get(saved.key)).value.status, 'pending');

  await recoverOwnership(f.service, f.input);
  const current = await f.records.get('flows/' + f.id);
  const currentInput = { ...input, flow: current.value, expectedRevision: current.value.revision };
  await f.other.coordination.operation('current-save', 'save-flow', currentInput);
  await assert.rejects(handleStoreAction(f.service, { ...command, operationId: 'current-save' }), {
    code: 'STORE_CONFLICT',
  });
  assert.deepEqual(await handleStoreAction(f.service, command), { reconciled: true });
  assert.deepEqual(await handleStoreAction(f.service, command), { reconciled: true });
  const rejected = await f.records.get(saved.key);
  assert.equal(rejected.value.status, 'rejected');
  assert.deepEqual(rejected.value.input, saved.value.input);
  assert.deepEqual(await f.records.get('flows/' + f.id), current);
  await assert.rejects(f.other.saveFlow({ ...input, operationId: 'stale-save' }), {
    code: 'STORE_SUPERSEDED_FLOW_SAVE',
  });
});
