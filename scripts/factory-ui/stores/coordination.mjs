import { randomUUID, createHash } from 'node:crypto';

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
      list(prefix) {
        return this.records.list(prefix);
      },
      async commit(operationId, expected, writes, sealToken) {
        const gate = await this.get('project/migration');
        this.requireGate(gate, sealToken);
        const conditions = new Map(expected.map((entry) => [entry.key, entry]));
        if (!conditions.has('project/migration'))
          conditions.set('project/migration', { key: 'project/migration', revision: gate?.revision ?? null });
        return this.records.commit({ operationId, expected: [...conditions.values()], writes: cloneRecord(writes) });
      },
      requireGate(gate, token) {
        if (!gate?.value) return;
        if (gate.value.token === token) return;
        throw storeFailure('STORE_MIGRATING', 'Project storage is sealed for a checked migration.', {
          migration: gate.value,
        });
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
          await this.commit(id + '/open', [{ key, revision: null }], [{ key, value }]);
        } catch (error) {
          const recorded = await this.get(key);
          if (recorded) return this.matchOperation(recorded, hash);
          throw error;
        }
        return this.get(key);
      },
      matchOperation(record, hash) {
        assertStoreState(
          record.value.inputHash === hash,
          'STORE_OPERATION_MISMATCH',
          'This operation identity already names different input.'
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
        await this.commit(
          operation.value.id + '/' + stage,
          [{ key, revision: current.revision }],
          [{ key, value }],
          sealToken
        );
        return this.get(key);
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
        await this.commit(
          operation.value.id + '/confirm',
          [...expected, { key: current.key, revision: current.revision }, { key: claim.key, revision: claim.revision }],
          updates
        );
        return (await this.get(current.key)).value;
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

export async function sealCoordination(coordination, { id, role, storeId, operationId }) {
  const claims = await coordination.list('claims/');
  assertStoreState(
    claims.length === 0,
    'STORE_BUSY',
    'Finish or explicitly reconcile all issue claims before moving project storage.'
  );
  const pending = (await coordination.list('operations/')).filter((record) => record.value.status === 'pending');
  assertStoreState(
    pending.every((record) => record.value.id === operationId),
    'STORE_PENDING',
    'Reconcile pending operations before moving project storage.'
  );
  const key = 'project/migration';
  const existing = await coordination.get(key);
  if (existing) {
    assertStoreState(existing.value.id === id, 'STORE_MIGRATING', 'Another project storage migration is pending.');
    return existing.value;
  }
  const value = { id, role, storeId, operationId, token: randomUUID(), state: 'sealed', sealedAt: coordination.now() };
  await coordination.commit(operationId + '/seal', [{ key, revision: null }], [{ key, value }]);
  const freshClaims = await coordination.list('claims/');
  const freshPending = (await coordination.list('operations/')).some(
    (record) => record.value.status === 'pending' && record.value.id !== operationId
  );
  if (freshClaims.length || freshPending) {
    const installed = await coordination.get(key);
    await coordination.commit(
      operationId + '/unseal-race',
      [{ key, revision: installed.revision }],
      [{ key, value: null }],
      value.token
    );
    throw storeFailure(
      freshPending ? 'STORE_PENDING' : 'STORE_BUSY',
      'Issue work or an update started before the migration seal. Reconcile it before continuing.'
    );
  }
  return value;
}
