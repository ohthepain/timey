import { AsyncLocalStorage } from 'node:async_hooks';
import { withRecordPayloads } from './providers/record-payloads.mjs';

export const metadataTransaction = new AsyncLocalStorage();

export function runMetadataOperation(stores, run) {
  const records = stores?.records;
  return withRecordPayloads(() =>
    records?.transaction
      ? stores.coordination.withWritableGate(() => metadataTransaction.run(records, () => records.transaction(run)))
      : run()
  );
}
