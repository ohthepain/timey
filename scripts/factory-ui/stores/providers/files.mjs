import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStore, checkExpected, hash, storeError, verifyReceipt, retireReceipt } from './records.mjs';

async function readState(path) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertStore((await handle.stat()).isFile(), 'The record snapshot must be a regular file.');
      const state = JSON.parse(await handle.readFile('utf8'));
      assertStore(
        state.version === 1 && Array.isArray(state.records) && Array.isArray(state.operations),
        'The record snapshot format is invalid.'
      );
      return state;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, records: [], operations: [] };
    if (error.code?.startsWith('STORE_')) throw error;
    throw storeError('STORE_UNAVAILABLE', 'The local record snapshot could not be read.');
  }
}

async function replaceState(directory, path, state) {
  const temporary = join(directory, `state-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function lock(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(path);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw storeError('STORE_UNAVAILABLE', 'The local store could not be locked.');
      await delay(10);
    }
  }
  throw storeError('STORE_LOCKED', 'The local store is busy. Reconcile a stopped writer before removing its lock.');
}

async function prepareDirectory(directory, readOnly) {
  if (!readOnly) await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  assertStore(entry?.isDirectory() || (readOnly && !entry), 'The record store must be a real directory.');
}

export async function openFilesRecords(config, { root, projectId, readOnly }) {
  const directory = resolve(root, config.directory || '.issues/stores', hash(JSON.stringify([projectId, config.id])));
  await prepareDirectory(directory, readOnly);
  const path = join(directory, 'state.json');
  async function mutate(request, change) {
    const lockPath = join(directory, 'write.lock');
    await lock(lockPath);
    try {
      const state = await readState(path);
      const prior = state.operations.find((item) => item.id === request.operationId);
      if (prior) return verifyReceipt(prior.receipt, request.inputDigest);
      const next = await change(state);
      await replaceState(directory, path, {
        ...next,
        operations: [...next.operations, { id: request.operationId, receipt: request.receipt }],
      });
      return request.receipt;
    } finally {
      await rm(lockPath, { recursive: true });
    }
  }
  return {
    async receipt(operationId) {
      return (await readState(path)).operations.find((item) => item.id === operationId)?.receipt ?? null;
    },
    async retainedPayloads() {
      const state = await readState(path);
      return { records: state.records, receipts: state.operations };
    },
    retireReceipts(request) {
      return mutate(request, (state) => {
        const selected = new Map(request.receipts.map((item) => [item.id, item]));
        const found = new Map(state.operations.map((item) => [item.id, item.receipt]));
        for (const item of request.receipts) retireReceipt(found.get(item.id), item, request);
        const operations = state.operations.map((item) =>
          selected.has(item.id)
            ? { id: item.id, receipt: retireReceipt(item.receipt, selected.get(item.id), request) }
            : item
        );
        return { ...state, operations };
      });
    },
    async readSnapshot(read) {
      const state = await readState(path);
      return read({
        get: async (key) => state.records.find((item) => item.key === key) ?? null,
        list: async (prefix) => state.records.filter((item) => item.key.startsWith(prefix)),
      });
    },
    async get(key) {
      return (await readState(path)).records.find((item) => item.key === key) ?? null;
    },
    async list(prefix) {
      return (await readState(path)).records.filter((item) => item.key.startsWith(prefix));
    },
    commit(request) {
      return mutate(request, (state) => {
        const records = new Map(state.records.map((item) => [item.key, item]));
        checkExpected(request.expected, records);
        for (const { key, record } of request.writes) {
          if (record) records.set(key, record);
          else records.delete(key);
        }
        return {
          version: 1,
          records: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
          operations: state.operations,
        };
      });
    },
  };
}
