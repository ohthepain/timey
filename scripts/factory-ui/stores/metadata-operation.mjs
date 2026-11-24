import { withRecordPayloads } from './providers/record-payloads.mjs';

export function runMetadataOperation(stores, run) {
  const records = stores?.records;
  return withRecordPayloads(() => (records?.transaction ? records.transaction(run) : run()));
}
