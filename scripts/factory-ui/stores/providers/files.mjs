import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStore, checkExpected, hash, storeError, verifyReceipt } from './records.mjs';

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

export async function openFilesRecords(config, { root, projectId }) {
  const directory = resolve(root, config.directory || '.issues/stores', hash(JSON.stringify([projectId, config.id])));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertStore(
    (await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(),
    'The record store must be a real directory.'
  );
  const path = join(directory, 'state.json');
  return {
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
    async commit(request) {
      const lockPath = join(directory, 'write.lock');
      await lock(lockPath);
      try {
        const state = await readState(path);
        const prior = state.operations.find((item) => item.id === request.operationId);
        if (prior) return verifyReceipt(prior.receipt, request.inputDigest);
        const records = new Map(state.records.map((item) => [item.key, item]));
        checkExpected(request.expected, records);
        for (const { key, record } of request.writes) {
          if (record) records.set(key, record);
          else records.delete(key);
        }
        await replaceState(directory, path, {
          version: 1,
          records: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
          operations: [...state.operations, { id: request.operationId, receipt: request.receipt }],
        });
        return request.receipt;
      } finally {
        await rm(lockPath, { recursive: true });
      }
    },
  };
}
