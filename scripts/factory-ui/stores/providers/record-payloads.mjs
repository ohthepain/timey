import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage();
const byteLimit = 32 * 1024 * 1024;

function activeScope() {
  const scope = scopes.getStore();
  return scope?.active ? scope : null;
}

export async function withRecordPayloads(run) {
  if (activeScope()) return run();
  const scope = { active: true, readers: new Map(), bytes: 0 };
  try {
    return await scopes.run(scope, run);
  } finally {
    scope.active = false;
    scope.readers.clear();
  }
}
async function loadPayload(scope, values, key, load) {
  try {
    const value = await Promise.resolve().then(load);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (scope.bytes + bytes <= byteLimit) scope.bytes += bytes;
    else values.delete(key);
    return value;
  } catch (error) {
    values.delete(key);
    throw error;
  }
}
async function cachedPayload(scope, identity, payload, load) {
  let values = scope.readers.get(identity);
  if (!values) {
    values = new Map();
    scope.readers.set(identity, values);
  }
  const { storeId, key: path, sha256, bytes } = payload.ref;
  const key = JSON.stringify([storeId, path, sha256, bytes]);
  if (!values.has(key)) values.set(key, loadPayload(scope, values, key, load));
  return structuredClone(await values.get(key));
}
export function recordPayload(identity, payload, load) {
  if (payload?.encoding !== 'artifact') return load();
  const scope = activeScope();
  return scope ? cachedPayload(scope, identity, payload, load) : load();
}
