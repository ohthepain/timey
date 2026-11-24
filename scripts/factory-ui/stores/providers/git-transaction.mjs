import { AsyncLocalStorage } from 'node:async_hooks';
import { createGitReadSet } from './git-read-set.mjs';
import { hash, storeError, verifyReceipt } from './records.mjs';

export function createGitTransactions(io) {
  const contexts = new AsyncLocalStorage();
  const recordPath = (key) => `${io.prefix}records/${hash(key)}.json`;
  const operationPath = (id) => `${io.prefix}operations/${hash(id)}.json`;
  function current() {
    const context = contexts.getStore();
    return context?.active ? context : null;
  }
  function read(use) {
    const context = current();
    return context ? use(context.head, context.changes) : io.withSnapshot(use);
  }
  function readSet(head) {
    const context = current();
    return context?.head === head ? context.readSet : null;
  }
  function original(head, path) {
    const set = readSet(head);
    return set ? set.get(path) : io.readPath(head, path);
  }
  function trackList(head, start) {
    readSet(head)?.list(start);
  }
  function baseList(head) {
    const set = readSet(head);
    return set ? set.all() : io.listAt(head, '');
  }
  function get(head, changes, path) {
    if (changes?.has(path)) return structuredClone(changes.get(path));
    return original(head, path);
  }
  async function list(head, changes = new Map(), start) {
    const records = new Map((await baseList(head)).map((record) => [recordPath(record.key), record]));
    for (const [path, record] of changes) {
      if (!path.startsWith(io.prefix + 'records/')) continue;
      if (record === null) records.delete(path);
      else records.set(path, record);
    }
    return structuredClone([...records.values()].filter((record) => record.key.startsWith(start))).sort((a, b) =>
      a.key.localeCompare(b.key)
    );
  }
  async function stage(context, request, changesFor) {
    const path = operationPath(request.operationId);
    const prior = await get(context.head, context.changes, path);
    if (prior) return verifyReceipt(prior, request.inputDigest);
    for (const [path, value] of await changesFor(context.head, context.changes)) context.changes.set(path, value);
    context.changes.set(path, request.receipt);
    return request.receipt;
  }
  async function publishedReceipt(head, [path, receipt]) {
    const prior = await io.readPath(head, path);
    if (!prior) return false;
    verifyReceipt(prior, receipt.inputDigest);
    return true;
  }
  async function published(context, head) {
    const receipts = [...context.changes].filter(([path]) => path.startsWith(io.prefix + 'operations/'));
    return (await Promise.all(receipts.map((entry) => publishedReceipt(head, entry)))).every(Boolean);
  }
  function contention(error) {
    return (
      error.code === 'STORE_CONFLICT' ||
      /stale info|fetch first|cannot lock ref|failed to update ref/.test(error.stderr || '')
    );
  }
  function publicationFailure(error) {
    if (contention(error))
      return storeError('STORE_CONFLICT', 'Shared metadata changed during the operation. Refresh before retrying.');
    return io.failure(error);
  }
  function reconcile(context, error, last) {
    return io.withSnapshot(async (head) => {
      if (await published(context, head)) return { confirmed: true };
      if (!contention(error) || last) throw publicationFailure(error);
      await context.readSet.check(head);
      return { head };
    });
  }
  async function publishBatch(context) {
    let head = context.head;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const commit = await io.commitTree(head, [...context.changes]);
        await io.push(commit, head, [...context.changes]);
        return;
      } catch (error) {
        const outcome = await reconcile(context, error, attempt === 4);
        if (outcome.confirmed) return;
        head = outcome.head;
      }
    }
  }
  function publish(context) {
    return context.changes.size ? publishBatch(context) : undefined;
  }
  async function execute(head, run) {
    const context = { head, changes: new Map(), readSet: createGitReadSet(io, head), active: true };
    try {
      const result = await contexts.run(context, run);
      await publish(context);
      return result;
    } finally {
      context.active = false;
    }
  }
  return {
    read,
    get,
    snapshotRecords: (head, changes) => list(head, changes, ''),
    trackList,
    list(head, changes, start) {
      trackList(head, start);
      return list(head, changes, start);
    },
    write(request, changesFor, fallback) {
      const context = current();
      return context ? stage(context, request, changesFor) : fallback(request, changesFor);
    },
    run(run) {
      return current() ? run() : io.withSnapshot((head) => execute(head, run));
    },
  };
}
