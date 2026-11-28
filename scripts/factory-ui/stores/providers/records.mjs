import { observeActivity } from '../../diagnostic-activity.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { recordPayload, withRecordPayloads } from './record-payloads.mjs';

const readScopes = new AsyncLocalStorage();

export function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function assertStore(condition, message) {
  if (!condition) throw storeError('STORE_INVALID', message);
}

function canonical(value) {
  const seen = new Set();
  function visit(input) {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    assertStore(typeof input === 'object' && input !== null && !seen.has(input), 'Store values must be JSON.');
    seen.add(input);
    let result;
    if (Array.isArray(input)) {
      assertStore(Object.keys(input).length === input.length, 'Store arrays must not contain holes.');
      result = input.map(visit);
    } else {
      assertStore(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
        'Store values must be plain JSON objects.'
      );
      result = Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, visit(input[key])])
      );
    }
    seen.delete(input);
    return result;
  }
  return JSON.stringify(visit(value));
}

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const revisionFor = (operationId, key) => hash(JSON.stringify([operationId, key]));

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= 900 && !key.includes('\0');
}

function normalizeRequest(input) {
  assertStore(
    input &&
      typeof input.operationId === 'string' &&
      input.operationId.length > 0 &&
      Buffer.byteLength(input.operationId) <= 900,
    'A bounded operation identity is required.'
  );
  assertStore(
    Array.isArray(input.expected) && Array.isArray(input.writes),
    'Expected revisions and writes are required.'
  );
  const expected = input.expected
    .map(({ key, revision }) => {
      assertStore(
        validKey(key) &&
          (revision === null ||
            (typeof revision === 'string' && revision.length > 0 && Buffer.byteLength(revision) <= 256)),
        'Each expected key needs a revision or null.'
      );
      return { key, revision };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const writes = input.writes
    .map(({ key, value }) => {
      assertStore(validKey(key) && value !== undefined, 'Each write needs a bounded key and JSON value or null.');
      return { key, value: JSON.parse(canonical(value)) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const checked = new Set(expected.map((item) => item.key));
  assertStore(
    checked.size === expected.length && new Set(writes.map((item) => item.key)).size === writes.length,
    'Commit keys must be unique.'
  );
  assertStore(
    expected.length <= 99 && writes.every((item) => checked.has(item.key)),
    'Check every written key and use at most 99 keys per commit.'
  );
  return { operationId: input.operationId, expected, writes, inputDigest: hash(canonical({ expected, writes })) };
}

export function verifyReceipt(receipt, inputDigest) {
  if (receipt.inputDigest !== inputDigest)
    throw storeError('STORE_OPERATION_MISMATCH', 'This operation identity already has a different payload.');
  if (receipt.deleted) throw storeError('STORE_DELETED', 'This operation belongs to a permanently deleted issue.');
  return receipt;
}

const receiptIdentity = (receipt) => hash(canonical(receipt));

export function retireReceipt(prior, expected, request) {
  if (!prior || prior.inputDigest !== expected.inputDigest)
    throw storeError('STORE_CONFLICT', 'The retained operation changed before deletion.');
  if (prior.deleted?.issueId === request.issueId && prior.deleted.deletionId === request.deletionId) return prior;
  if (receiptIdentity(prior) !== expected.identity)
    throw storeError('STORE_CONFLICT', 'The retained operation changed before deletion.');
  return { inputDigest: prior.inputDigest, deleted: { issueId: request.issueId, deletionId: request.deletionId } };
}

export function checkExpected(expected, records) {
  for (const item of expected) {
    if ((records.get(item.key)?.revision ?? null) !== item.revision)
      throw storeError('STORE_CONFLICT', 'The stored revision changed. Refresh before editing.');
  }
}

async function pack(value, artifacts, allowInlineLarge, inlineLimit) {
  const body = Buffer.from(canonical(value));
  if (body.length <= inlineLimit || (!artifacts && allowInlineLarge))
    return { encoding: 'json', value: JSON.parse(body.toString()) };
  assertStore(artifacts?.put && artifacts?.get, 'Large store values require a configured Artifact store.');
  return { encoding: 'artifact', ref: await artifacts.put({ body, mediaType: 'application/json' }) };
}

function boundedReferenceIndex(index) {
  return Buffer.byteLength(JSON.stringify(index)) <= 32_768;
}

function indexRecordReferences(payload, value) {
  if (payload.encoding !== 'artifact') return payload;
  const referenceIndex = {
    version: 1,
    ...(typeof value?.kind === 'string' && { kind: value.kind }),
    refs: references(value).map(({ storeId, key, sha256, bytes, mediaType }) => ({
      storeId,
      key,
      sha256,
      bytes,
      ...(typeof mediaType === 'string' && { mediaType }),
    })),
  };
  return boundedReferenceIndex(referenceIndex) ? { ...payload, referenceIndex } : payload;
}

async function unpack(payload, artifacts) {
  if (payload?.encoding === 'json') return JSON.parse(JSON.stringify(payload.value));
  assertStore(payload?.encoding === 'artifact' && artifacts?.get, 'The stored payload requires its Artifact store.');
  return JSON.parse((await artifacts.get(payload.ref)).toString('utf8'));
}

function artifactReference(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.storeId === 'string' &&
    typeof value.key === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}

function references(value) {
  const retained = new Map();
  function visit(input) {
    if (!input || typeof input !== 'object') return;
    if (artifactReference(input)) retained.set(canonical(input), input);
    for (const nested of Object.values(input)) visit(nested);
  }
  visit(value);
  return [...retained.values()];
}

function inventoryRecord(record, storeId) {
  const value = record.value;
  if (
    !artifactReference(value?.ref) ||
    value.ref.storeId !== storeId ||
    record.key !== 'artifact/' + value.ref.sha256 ||
    typeof value.body !== 'string'
  )
    return false;
  const body = Buffer.from(value.body, 'base64');
  return hash(body) === value.ref.sha256 && body.length === value.ref.bytes;
}

function artifactReceipt(entry, ref, storeId) {
  const result = entry.receipt.result;
  if (result?.encoding !== 'json' || !Array.isArray(result.value?.records) || !result.value.records.length)
    return false;
  return result.value.records.every((record) => {
    if (record.value?.encoding !== 'json') return false;
    const decoded = { ...record, value: record.value.value };
    return (
      inventoryRecord(decoded, storeId) &&
      ['key', 'sha256', 'bytes'].every((key) => decoded.value.ref[key] === ref[key])
    );
  });
}

async function decodedWithRefs(record, decode, onUnreadable, referencesOnly, index = record.value?.referenceIndex) {
  const { encoding, ref } = record.value ?? {};
  if (
    referencesOnly &&
    encoding === 'artifact' &&
    index?.version === 1 &&
    Array.isArray(index.refs) &&
    index.refs.every(artifactReference)
  ) {
    return { ...record, value: { kind: index.kind }, refs: [ref, ...index.refs] };
  }
  const decoded = await retainedEntry(() => decode(record), onUnreadable);
  return {
    ...record,
    value: decoded?.value,
    refs: references([record.value, decoded?.value]),
  };
}

async function retainedReceipt(entry, decode, unpackPayload, onUnreadable, referencesOnly) {
  const { receipt } = entry;
  const result = receipt.deleted ? { records: [] } : await unpackPayload(receipt.result);
  assertStore(Array.isArray(result.records), 'The retained operation result is invalid.');
  const records = await Promise.all(
    result.records.map((record, index) =>
      decodedWithRefs(record, decode, onUnreadable, referencesOnly, receipt.recordReferenceIndexes?.[index])
    )
  );
  return {
    id: entry.id,
    inputDigest: receipt.inputDigest,
    identity: receiptIdentity(receipt),
    records,
    payloadRef: receipt.result?.ref,
    refs: references([receipt.result || {}, result, records]),
  };
}

async function retainedEntry(read, onUnreadable) {
  try {
    return await read();
  } catch (error) {
    if (!onUnreadable) throw error;
    onUnreadable();
    return null;
  }
}

function unreadableReceipt({ id, receipt }) {
  const ref = receipt.result?.ref;
  return artifactReference(ref) ? { id, identity: receiptIdentity(receipt), records: [], payloadRef: ref } : null;
}

function isInventoryReceipt(receipt, storeId) {
  return receipt.records.length > 0 && receipt.records.every((record) => inventoryRecord(record, storeId));
}

function referenceDetails({ key, revision, value, refs }) {
  return { key, revision, value: { kind: value?.kind }, refs };
}

function referenceReceiptDetails({ id, identity, payloadRef, records }) {
  return { id, identity, payloadRef, records: records.map(referenceDetails) };
}

const unchanged = (entry) => entry;

async function readRetainedReceipt(entry, decode, unpackPayload, onUnreadable, referencesOnly) {
  const receipt = await retainedEntry(
    () => retainedReceipt(entry, decode, unpackPayload, onUnreadable, referencesOnly),
    onUnreadable
  );
  return receipt ?? unreadableReceipt(entry);
}

async function visitRetained(backend, stream, visitRecord, visitReceipt) {
  const raw = await backend.retainedPayloads(stream ? { visitRecord, visitReceipt } : undefined);
  for (const record of raw.records) await visitRecord(record);
  for (const entry of raw.receipts) await visitReceipt(entry);
}

async function collectRetained(backend, decode, unpackPayload, settings) {
  const { excludeArtifactInventory, storeId, onUnreadable, referencesOnly, onRecord, onReceipt } = settings;
  const records = [];
  const receipts = [];
  const projectRecord = referencesOnly ? referenceDetails : unchanged;
  const projectReceipt = referencesOnly ? referenceReceiptDetails : unchanged;
  const visitRecord = async (record) => {
    const decoded = await decodedWithRefs(record, decode, onUnreadable, referencesOnly);
    if (excludeArtifactInventory && inventoryRecord(decoded, storeId)) return;
    if (onRecord) await onRecord(decoded);
    else records.push(projectRecord(decoded));
  };
  const visitReceipt = async (entry) => {
    const receipt = await readRetainedReceipt(entry, decode, unpackPayload, onUnreadable, referencesOnly);
    if (!receipt || (excludeArtifactInventory && isInventoryReceipt(receipt, storeId))) return;
    if (onReceipt) await onReceipt(receipt);
    else receipts.push(projectReceipt(receipt));
  };
  await visitRetained(backend, referencesOnly || onRecord || onReceipt, visitRecord, visitReceipt);
  return { records, receipts };
}

function retirementRequest(input) {
  assertStore(
    validKey(input?.operationId) && validKey(input.deletionId) && /^[\w-]{1,200}$/.test(input.issueId),
    'Receipt deletion needs bounded operation and issue identities.'
  );
  assertStore(
    Array.isArray(input.receipts) && input.receipts.length <= 99,
    'Retire at most ninety-nine operation receipts at once.'
  );
  const receipts = input.receipts
    .map(({ id, inputDigest, identity }) => {
      assertStore(
        validKey(id) && /^[a-f0-9]{64}$/.test(inputDigest) && /^[a-f0-9]{64}$/.test(identity),
        'Choose verified retained operation receipts.'
      );
      return { id, inputDigest, identity };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  assertStore(
    new Set(receipts.map(({ id }) => id)).size === receipts.length,
    'Retained operation receipts must be unique.'
  );
  const inputDigest = hash(canonical({ issueId: input.issueId, deletionId: input.deletionId, receipts }));
  const result = { operationId: input.operationId, retired: receipts.map(({ id }) => id), records: [] };
  return { ...input, receipts, inputDigest, receipt: { inputDigest, result: { encoding: 'json', value: result } } };
}

function writtenValues(request, records) {
  const values = new Map(request.writes.map(({ key, value }) => [key, value]));
  return {
    operationId: request.operationId,
    records: records.map((record) => ({ ...record, value: values.get(record.key) })),
  };
}

export function recordStore(backend, artifacts, { allowInlineLarge = false, storeId } = {}) {
  const identity = {};
  const inlineLimit = backend.inlineLimit ?? 16_384;
  const unpackPayload = (payload) => {
    const scope = readScopes.getStore();
    return recordPayload(identity, payload, () =>
      readScopes.run({ readers: scope?.readers, decoding: true }, () => unpack(payload, artifacts))
    );
  };
  const decode = async (record) => record && { ...record, value: await unpackPayload(record.value) };
  async function listDecoded(pinned, prefix, select) {
    if (!select) return Promise.all((await pinned.list(prefix)).map(decode));
    const selected = [];
    const visit = async (record) => {
      const value = select(await decode(record));
      if (value !== undefined) selected.push(value);
    };
    if (pinned.visit) await pinned.visit(prefix, visit);
    else for (const record of await pinned.list(prefix)) await visit(record);
    return selected;
  }
  function reader() {
    const scope = readScopes.getStore();
    const selected = scope?.decoding && scope.readers?.get(identity);
    return selected?.active ? selected.reader : backend;
  }
  function readCurrent(work) {
    return readScopes.getStore()?.decoding ? work() : readScopes.exit(work);
  }
  return {
    id: storeId,
    ...(backend.transaction && {
      transaction: (run) =>
        observeActivity('stores', 'Metadata transaction', { store: storeId }, () =>
          withRecordPayloads(() => backend.transaction(run))
        ),
    }),
    ...(backend.readSnapshot && {
      async readSnapshot(read) {
        return observeActivity('stores', 'Read snapshot', { store: storeId }, () =>
          backend.readSnapshot(async (pinned) => {
            const readers = new Map(readScopes.getStore()?.readers);
            const entry = { reader: pinned, active: true };
            readers.set(identity, entry);
            try {
              return await readScopes.run({ readers, decoding: false }, () =>
                read({
                  get: async (key) => decode(await pinned.get(key)),
                  list: (prefix, select) => listDecoded(pinned, prefix || '', select),
                })
              );
            } finally {
              entry.active = false;
            }
          })
        );
      },
    }),
    async get(key) {
      assertStore(validKey(key), 'A bounded record key is required.');
      return readCurrent(() =>
        observeActivity('stores', 'Read record', { store: storeId }, async () => decode(await reader().get(key)))
      );
    },
    async registerArtifactUpload({ bucket, objectKey, sha256, bytes }, { released = false } = {}) {
      assertStore(
        typeof bucket === 'string' &&
          bucket.length > 0 &&
          bucket.length <= 255 &&
          typeof objectKey === 'string' &&
          Buffer.byteLength(objectKey) <= 1024 &&
          /^[a-f0-9]{64}$/.test(sha256) &&
          Number.isSafeInteger(bytes) &&
          bytes >= 0,
        'Register a bounded S3 object identity.'
      );
      const key = 'artifact-uploads/' + hash(JSON.stringify([bucket, objectKey]));
      const value = { bucket, objectKey, sha256, bytes };
      const current = await this.get(key);
      if (current) {
        assertStore(
          Object.keys(value).every((field) => current.value[field] === value[field]),
          'The S3 artifact identity changed.'
        );
        if (released && current.value.released) return;
      }
      const next = { ...value, touchedAt: new Date().toISOString(), released };
      try {
        await this.commit({
          operationId: key + '/' + randomUUID(),
          expected: [{ key, revision: current?.revision ?? null }],
          writes: [{ key, value: next }],
        });
      } catch (error) {
        if (error.code !== 'STORE_CONFLICT') throw error;
        return this.registerArtifactUpload(value, { released });
      }
    },
    async list(prefix = '', select) {
      assertStore(typeof prefix === 'string' && !prefix.includes('\0'), 'A record prefix is required.');
      if (backend.readSnapshot) return readCurrent(() => this.readSnapshot((pinned) => pinned.list(prefix, select)));
      return readCurrent(() =>
        observeActivity('stores', 'List records', { store: storeId }, () => listDecoded(reader(), prefix, select))
      );
    },
    async listPendingOperations(select) {
      if (!backend.listPendingOperations) return this.list('operations/', select);
      return readCurrent(() =>
        observeActivity('stores', 'List pending operations', { store: storeId }, async () => {
          const records = await backend.listPendingOperations();
          const selected = [];
          for (let offset = 0; offset < records.length; offset += 16) {
            const raw = records.slice(offset, offset + 16);
            const page = await Promise.all(raw.map(decode));
            const finished = [];
            for (const [index, entry] of page.entries()) {
              if (entry.value.status !== 'pending' && raw[index].value.encoding === 'artifact') finished.push(entry);
              const value = select(entry);
              if (value !== undefined) selected.push(value);
            }
            if (finished.length) await backend.rememberFinishedOperations?.(finished);
          }
          return selected;
        })
      );
    },
    async removeRecords({ operationId, expected }) {
      assertStore(Array.isArray(expected), 'Checked record revisions are required for deletion.');
      return this.commit({
        operationId,
        expected,
        writes: expected.map(({ key }) => ({ key, value: null })),
      });
    },
    async retainedPayloads({
      excludeArtifactInventory = false,
      onUnreadable,
      referencesOnly = false,
      onRecord,
      onReceipt,
    } = {}) {
      return collectRetained(backend, decode, unpackPayload, {
        excludeArtifactInventory,
        storeId,
        onUnreadable,
        referencesOnly,
        onRecord,
        onReceipt,
      });
    },
    async artifactReceipts(ref) {
      assertStore(artifactReference(ref) && ref.storeId === storeId, 'Choose an Artifact reference in this store.');
      const receipts = [];
      await visitRetained(
        backend,
        true,
        () => {},
        (entry) => {
          if (!artifactReceipt(entry, ref, storeId)) return;
          const { id, receipt } = entry;
          receipts.push({ id, inputDigest: receipt.inputDigest, identity: receiptIdentity(receipt) });
        }
      );
      return receipts;
    },
    async retireReceipts(input) {
      return readScopes.exit(async () => {
        const receipt = await backend.retireReceipts(retirementRequest(input));
        const result = await unpack(receipt.result, artifacts);
        return { operationId: result.operationId, retired: result.retired };
      });
    },
    async commit(input) {
      return readScopes.exit(async () => {
        const request = normalizeRequest(input);
        const prior = await backend.receipt(request.operationId);
        if (prior) {
          verifyReceipt(prior, request.inputDigest);
          const result = await unpack(prior.result, artifacts);
          return {
            ...result,
            records: await Promise.all(result.records.map(decode)),
          };
        }
        const writes = await Promise.all(
          request.writes.map(async ({ key, value }) => ({
            key,
            record:
              value === null
                ? null
                : {
                    key,
                    revision: revisionFor(request.operationId, key),
                    value: indexRecordReferences(await pack(value, artifacts, allowInlineLarge, inlineLimit), value),
                  },
          }))
        );
        const records = writes.flatMap((item) => (item.record ? [item.record] : []));
        const recordReferenceIndexes = records.map(({ value }) => value.referenceIndex ?? null);
        const receiptRecords = records.map(
          ({ key, revision, value: { referenceIndex: _referenceIndex, ...value } }) => ({
            key,
            revision,
            value,
          })
        );
        const receipt = {
          inputDigest: request.inputDigest,
          result: await pack(
            { operationId: request.operationId, records: receiptRecords },
            artifacts,
            allowInlineLarge,
            inlineLimit
          ),
          ...(recordReferenceIndexes.some(Boolean) &&
            boundedReferenceIndex(recordReferenceIndexes) && { recordReferenceIndexes }),
        };
        const committed = await observeActivity('stores', 'Write records', { store: storeId }, () =>
          backend.commit({ ...request, writes, receipt })
        );
        if (committed === receipt) return writtenValues(request, records);
        const result = await unpack(committed.result, artifacts);
        return {
          ...result,
          records: await Promise.all(result.records.map(decode)),
        };
      });
    },
    async close() {
      await backend.close?.();
    },
  };
}
