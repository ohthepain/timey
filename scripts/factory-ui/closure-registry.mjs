import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { digest, writeJson } from './common.mjs';
import { savePlanDecision } from './plan-decision-record.mjs';

export function currentRegistryEvidence(queue, entry) {
  return entry.path === join(queue.root, '.issues/factory.json');
}
export function retainClosingRegistry(service, queue, issue) {
  const record = structuredClone(issue.plan_verification);
  const entry = record.evidence.find((e) => currentRegistryEvidence(queue, e));
  if (!entry) return queue;
  if (digest(readFileSync(entry.path)) === entry.sha256) return queue;
  const run = service.store.add({ id: 'final-task-record' }, 'plan-decision', queue.head);
  try {
    const source = entry.path;
    const path = join(service.store.directory, run.id + '-task-record.json');
    writeJson(path, {
      source,
      earlier_sha256: entry.sha256,
      purpose: 'Current administrative task status at explicit final acceptance; not a new behavior check.',
      registry: JSON.parse(readFileSync(source, 'utf8')),
    });
    Object.assign(entry, { path, sha256: digest(readFileSync(path)) });
    record.steps
      .flatMap((step) => step.criteria)
      .forEach((criterion) => {
        criterion.evidence = criterion.evidence.map((p) => (p === source ? path : p));
      });
    record.run_id = run.id;
    savePlanDecision(
      service,
      issue,
      run,
      {
        summary: 'Current task status retained for final acceptance.',
        notes:
          'The live task log changed as review finished. Its current administrative state is retained separately; the earlier hash is preserved. Test results and manual skips are unchanged.',
        remaining: [],
        plan_verification: record,
      },
      [entry]
    );
  } finally {
    service.store.connected.delete(run.id);
  }
  return readQueue(service.root);
}
