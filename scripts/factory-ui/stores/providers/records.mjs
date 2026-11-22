import { createHash } from 'node:crypto';

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
  return receipt;
}

export function checkExpected(expected, records) {
  for (const item of expected) {
    if ((records.get(item.key)?.revision ?? null) !== item.revision)
      throw storeError('STORE_CONFLICT', 'The stored revision changed. Refresh before editing.');
  }
}

async function pack(value, artifacts, allowInlineLarge) {
  const body = Buffer.from(canonical(value));
  if (body.length <= 16_384 || (!artifacts && allowInlineLarge))
    return { encoding: 'json', value: JSON.parse(body.toString()) };
  assertStore(artifacts?.put && artifacts?.get, 'Large store values require a configured Artifact store.');
  return { encoding: 'artifact', ref: await artifacts.put({ body, mediaType: 'application/json' }) };
}

async function unpack(payload, artifacts) {
  if (payload?.encoding === 'json') return JSON.parse(JSON.stringify(payload.value));
  assertStore(payload?.encoding === 'artifact' && artifacts?.get, 'The stored payload requires its Artifact store.');
  return JSON.parse((await artifacts.get(payload.ref)).toString('utf8'));
}

export function recordStore(backend, artifacts, { allowInlineLarge = false } = {}) {
  const decode = async (record) => record && { ...record, value: await unpack(record.value, artifacts) };
  return {
    ...(backend.readSnapshot && {
      async readSnapshot(read) {
        return backend.readSnapshot((pinned) =>
          read({
            get: async (key) => decode(await pinned.get(key)),
            list: async (prefix) => Promise.all((await pinned.list(prefix || '')).map(decode)),
          })
        );
      },
    }),
    async get(key) {
      assertStore(validKey(key), 'A bounded record key is required.');
      return decode(await backend.get(key));
    },
    async list(prefix = '') {
      assertStore(typeof prefix === 'string' && !prefix.includes('\0'), 'A record prefix is required.');
      return Promise.all((await backend.list(prefix)).map(decode));
    },
    async commit(input) {
      const request = normalizeRequest(input);
      const writes = await Promise.all(
        request.writes.map(async ({ key, value }) => ({
          key,
          record:
            value === null
              ? null
              : {
                  key,
                  revision: revisionFor(request.operationId, key),
                  value: await pack(value, artifacts, allowInlineLarge),
                },
        }))
      );
      const records = writes.flatMap((item) => (item.record ? [item.record] : []));
      const receipt = {
        inputDigest: request.inputDigest,
        result: await pack({ operationId: request.operationId, records }, artifacts, allowInlineLarge),
      };
      const committed = await backend.commit({ ...request, writes, receipt });
      const result = await unpack(committed.result, artifacts);
      return { ...result, records: await Promise.all(result.records.map(decode)) };
    },
    async close() {
      await backend.close?.();
    },
  };
}
