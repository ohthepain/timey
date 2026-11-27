import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownsDeletedRecord } from './deletion-retention.mjs';
import { metadataTransaction } from './metadata-operation.mjs';

export const cloneRecord = (value) => JSON.parse(JSON.stringify(value));

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(value[key])])
  );
}

export function inputDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}

export function storeFailure(code, message, details = {}) {
  return Object.assign(Error(message), { code, ...details });
}

export function assertStoreState(condition, code, message) {
  if (!condition) throw storeFailure(code, message);
}

export function validIdentity(value, label = 'issue') {
  assertStoreState(
    typeof value === 'string' && /^[\w-]{1,200}$/.test(value),
    'STORE_INVALID_ID',
    `Choose a valid ${label} identity.`
  );
  return value;
}

export function sameOwner(a, b) {
  return Boolean(a && b && a.token === b.token && a.attemptId === b.attemptId && a.runnerId === b.runnerId);
}

const isProposalSeal = (gate) => gate?.value.role === 'delete-proposal';

async function retryGate(coordination, error) {
  if (!['STORE_PROPOSAL_DELETING', 'STORE_CONFLICT'].includes(error.code)) throw error;
  const gate = await coordination.get('project/migration');
  if (error.code === 'STORE_CONFLICT' && !isProposalSeal(gate)) throw error;
  return gate;
}

async function waitForWritableGate(coordination, error, deadline) {
  let gate = await retryGate(coordination, error);
  while (isProposalSeal(gate)) {
    if (Date.now() >= deadline)
      throw storeFailure('STORE_MIGRATING', 'Resume the interrupted proposal deletion in Project settings.');
    await delay(50);
    gate = await coordination.get('project/migration');
  }
}

async function runWhenWritable(coordination, run) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      await waitForWritableGate(coordination, error, deadline);
    }
  }
}

function sealedStoreError(gate) {
  if (isProposalSeal(gate))
    return storeFailure('STORE_PROPOSAL_DELETING', 'Project storage is sealed while deleting a proposal.');
  return storeFailure('STORE_MIGRATING', 'Project storage is sealed for a checked migration.', {
    migration: gate.value,
  });
}

export function createArtifactRouter({ active, stores, records }) {
  let selected = active;
  const available = stores instanceof Map ? stores : new Map(Object.entries(stores || {}));
  available.set(active.id, active);
  async function destination(ref) {
    assertStoreState(
      typeof ref?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256),
      'STORE_ARTIFACT_REFERENCE',
      'Choose a valid immutable artifact reference.'
    );
    const source = typeof records === 'function' ? records() : records;
    const location = source ? await source.get('artifact-locations/' + ref.sha256) : null;
    const selectedRef = location?.value.ref || ref;
    assertStoreState(
      selectedRef.sha256 === ref.sha256 && selectedRef.bytes === ref.bytes,
      'STORE_ARTIFACT_REFERENCE',
      'The artifact relocation changed its immutable identity.'
    );
    return selectedRef;
  }
  async function provider(ref) {
    const mapped = await destination(ref);
    const physical = available.get(mapped.storeId);
    assertStoreState(Boolean(physical), 'STORE_UNCONFIGURED', 'The referenced Artifact store is not configured.');
    return { mapped, physical };
  }
  async function authoritative() {
    const source = typeof records === 'function' ? records() : records;
    const roles = source && (await source.get('project/store-roles'));
    if (roles?.value.artifacts && roles.value.artifacts !== selected.id) {
      const destination = available.get(roles.value.artifacts);
      assertStoreState(
        Boolean(destination),
        'STORE_UNCONFIGURED',
        'Configure the project’s migrated Artifact store before writing shared files.'
      );
      selected = destination;
    }
    return selected;
  }
  return {
    get id() {
      return selected.id;
    },
    get physical() {
      return selected;
    },
    stores: available,
    select(store) {
      available.set(store.id, store);
      selected = store;
    },
    put: async (input) => (await authoritative()).put(input),
    list: async () => (await authoritative()).list(),
    async get(ref) {
      const found = await provider(ref);
      return found.physical.get(found.mapped);
    },
    async inspect(ref) {
      const found = await provider(ref);
      return found.physical.inspect(found.mapped);
    },
    async remove(ref) {
      const found = await provider(ref);
      return found.physical.remove(found.mapped);
    },
  };
}

export function createIssueArtifactRouter({ active, stores, records }) {
  const reader = createArtifactRouter({ active, stores, records });
  async function get(ref) {
    try {
      return await active.get({ ...ref, storeId: active.id });
    } catch (error) {
      if (error.code !== 'ARTIFACT_MISSING') throw error;
      return reader.get(ref);
    }
  }
  async function inspect(ref) {
    return (await active.inspect({ ...ref, storeId: active.id })) || reader.inspect(ref);
  }
  return {
    id: active.id,
    physical: active,
    stores: reader.stores,
    put: (input) => active.put(input),
    list: () => active.list(),
    get,
    inspect,
    remove: (ref) => reader.remove(ref),
  };
}

export function createCoordination(records, { runnerId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const coordination = {};

  coordination.records = records;
  coordination.runnerId = runnerId;
  coordination.now = now;

  return Object.defineProperties(
    coordination,
    Object.getOwnPropertyDescriptors({
      get(key) {
        return this.records.get(key);
      },
      list(prefix, select) {
        return this.records.list(prefix, select);
      },
      async commit(operationId, expected, writes, sealToken) {
        const commit = async () => {
          const gate = await this.get('project/migration');
          this.requireGate(gate, sealToken);
          const conditions = new Map(expected.map((entry) => [entry.key, entry]));
          if (!conditions.has('project/migration'))
            conditions.set('project/migration', { key: 'project/migration', revision: gate?.revision ?? null });
          return this.records.commit({ operationId, expected: [...conditions.values()], writes: cloneRecord(writes) });
        };
        return sealToken ? commit() : this.withWritableGate(commit);
      },
      withWritableGate(run) {
        return metadataTransaction.getStore() === this.records ? run() : runWhenWritable(this, run);
      },
      requireGate(gate, token) {
        if (!gate?.value) return;
        if (gate.value.token === token) return;
        throw sealedStoreError(gate);
      },
      async operation(id, kind, input, { claimAdmission = false } = {}) {
        assertStoreState(
          typeof id === 'string' && id.length > 0 && id.length < 500,
          'STORE_INVALID_OPERATION',
          'Supply a stable operation identity.'
        );
        const key = 'operations/' + encodeURIComponent(id);
        const hash = inputDigest({ kind, input });
        const previous = await this.get(key);
        if (previous) return this.matchOperation(previous, hash);
        const value = {
          id,
          kind,
          input: cloneRecord(input),
          inputHash: hash,
          status: 'pending',
          createdAt: this.now(),
          runnerId: this.runnerId,
          token: randomUUID(),
          ...(claimAdmission && { claimAdmission: true }),
        };
        try {
          const saved = await this.commit(id + '/open', [{ key, revision: null }], [{ key, value }]);
          return saved.records.find((record) => record.key === key);
        } catch (error) {
          const recorded = await this.get(key);
          if (recorded) return this.matchOperation(recorded, hash);
          throw error;
        }
      },
      matchOperation(record, hash) {
        assertStoreState(
          record.value.inputHash === hash,
          'STORE_OPERATION_MISMATCH',
          'This operation identity already names different input.'
        );
        assertStoreState(
          !record.value.deletedIssueIds?.length,
          'STORE_DELETED',
          'This historical operation includes a permanently deleted issue.'
        );
        if (record.value.status === 'rejected')
          throw storeFailure(record.value.errorCode, record.value.error, { rejected: true, pending: false });
        return record;
      },
      async updateOperation(operation, changes, stage, sealToken) {
        const key = operation.key;
        const current = await this.get(key);
        this.matchOperation(current, operation.value.inputHash);
        const value = { ...current.value, ...cloneRecord(changes) };
        const saved = await this.commit(
          operation.value.id + '/' + stage,
          [{ key, revision: current.revision }],
          [{ key, value }],
          sealToken
        );
        return saved.records.find((record) => record.key === key);
      },
      owner(operation, issueId, attemptId = operation.value.id) {
        return {
          issueId,
          attemptId,
          token: operation.value.token,
          runnerId: operation.value.runnerId || this.runnerId,
          acquiredAt: operation.value.createdAt,
        };
      },
      async acquire(owner, operationId) {
        const key = 'claims/' + validIdentity(owner.issueId);
        const existing = await this.get(key);
        if (existing) {
          assertStoreState(
            sameOwner(existing.value, owner),
            'STORE_CLAIMED',
            'Another runner or attempt owns this issue.'
          );
          return existing.value;
        }
        await this.commit(operationId, [{ key, revision: null }], [{ key, value: owner }]);
        return owner;
      },
      async owned(owner) {
        const current = await this.get('claims/' + validIdentity(owner.issueId));
        assertStoreState(
          sameOwner(current?.value, owner),
          'STORE_NOT_OWNER',
          'The exact issue claim is no longer owned by this attempt.'
        );
        return current;
      },
      async release(owner, operationId) {
        const current = await this.owned(owner);
        await this.commit(
          operationId,
          [{ key: current.key, revision: current.revision }],
          [{ key: current.key, value: null }]
        );
      },
      async finalize(operation, owner, writes = [], expected = [], result = {}) {
        return this.confirmOperation(operation, owner, writes, expected, { release: true, result });
      },
      async confirmOwned(operation, owner, writes = [], expected = []) {
        return this.confirmOperation(operation, owner, writes, expected, { release: false });
      },
      async confirmOperation(operation, owner, writes, expected, options) {
        const current = await this.get(operation.key);
        this.matchOperation(current, operation.value.inputHash);
        if (current.value.status === 'confirmed') return current.value;
        const claim = await this.owned(owner);
        const value = { ...current.value, status: 'confirmed', confirmedAt: this.now() };
        if (options.release) value.result = options.result;
        const updates = [...writes, { key: current.key, value }];
        if (options.release) updates.push({ key: claim.key, value: null });
        const saved = await this.commit(
          operation.value.id + '/confirm',
          [...expected, { key: current.key, revision: current.revision }, { key: claim.key, revision: claim.revision }],
          updates
        );
        return saved.records.find((record) => record.key === current.key).value;
      },
      async pending(operation, error) {
        const current = await this.get(operation.key);
        if (current?.value.status === 'confirmed') return current.value;
        const changes = { error: String(error?.message || 'Storage operation could not be confirmed.') };
        const stage = 'pending-' + inputDigest(changes).slice(0, 12);
        try {
          return (await this.updateOperation(operation, changes, stage)).value;
        } catch {
          return { ...operation.value, ...changes };
        }
      },
    })
  );
}

export async function deletionBlockers(coordination, { issueId, operationId } = {}) {
  const includes = issueId ? (record) => ownsDeletedRecord(record, issueId) : () => true;
  const [claims, pending] = await Promise.all([
    issueId
      ? coordination.get('claims/' + issueId).then(Boolean)
      : coordination.list('claims/').then((rows) => rows.length > 0),
    coordination.list('operations/', (record) =>
      record.value.status === 'pending' && record.value.id !== operationId && includes(record)
        ? record.value
        : undefined
    ),
  ]);
  return { claims, pending: pending[0] };
}

async function requireSealAvailable(coordination, scope) {
  const { claims, pending } = await deletionBlockers(coordination, scope);
  assertStoreState(
    !claims,
    'STORE_BUSY',
    scope.issueId
      ? 'Finish or explicitly reconcile the proposal’s claim before deleting it.'
      : 'Finish or explicitly reconcile all issue claims before moving project storage.'
  );
  assertStoreState(
    !pending,
    'STORE_PENDING',
    scope.issueId
      ? 'Reconcile the proposal’s pending operation before deleting it.'
      : 'Reconcile pending operations before moving project storage.'
  );
}

async function checkSealRace(coordination, scope, installed) {
  const { claims, pending } = await deletionBlockers(coordination, scope);
  if (!claims && !pending) return;
  const key = 'project/migration';
  const gate = await coordination.get(key);
  await coordination.commit(
    scope.operationId + '/unseal-race/' + installed.token,
    [{ key, revision: gate.revision }],
    [{ key, value: null }],
    installed.token
  );
  throw storeFailure(
    pending ? 'STORE_PENDING' : 'STORE_BUSY',
    'Issue work or an update started before the storage seal. Reconcile it before continuing.'
  );
}

export async function sealCoordination(coordination, { id, role, storeId, operationId, issueId, expected = [] }) {
  const scope = { issueId, operationId };
  await requireSealAvailable(coordination, scope);
  const key = 'project/migration';
  const existing = await coordination.get(key);
  if (existing) {
    assertStoreState(existing.value.id === id, 'STORE_MIGRATING', 'Another project storage migration is pending.');
    return existing.value;
  }
  const value = { id, role, storeId, operationId, token: randomUUID(), state: 'sealed', sealedAt: coordination.now() };
  await coordination.commit(
    operationId + '/seal/' + value.token,
    [...expected, { key, revision: null }],
    [{ key, value }],
    value.token
  );
  await checkSealRace(coordination, scope, value);
  return value;
}
