import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './common.mjs';

export function loadLifecycles(root) {
  const path = join(root, '.issues/factory-ui/lifecycle.json');
  if (!existsSync(path)) return {};
  const ledger = readJson(path);
  if (!validLifecycleLedger(ledger)) throw Error('The saved progress record needs repair. It has not been reset.');
  return ledger.issues;
}
export function saveLifecycle(service, record, changes = {}) {
  Object.assign(record, changes, { updated: new Date().toISOString() });
  service.lifecycleRuns[record.issueId] = record;
  mkdirSync(service.store.directory, { recursive: true });
  writeJson(join(service.store.directory, 'lifecycle.json'), { version: 1, issues: service.lifecycleRuns });
}
export function lifecycleEvent(service, record, message, values = {}) {
  record.events.push({ at: new Date().toISOString(), message, ...values });
  saveLifecycle(service, record, { summary: message });
}
export function lifecycleView(service, issue) {
  const record = service.lifecycleRuns[issue.id];
  if (!record) return null;
  const legacy = legacyStoppedView(record);
  if (legacy) return legacy;
  return interruptedView(service, issue, record);
}
function interruptedView(service, issue, record) {
  if (record.status === 'running' && !service.lifecycleTasks.has(issue.id))
    return {
      ...record,
      status: 'paused',
      summary: 'Progress was interrupted. Resume will check the saved work before continuing.',
    };
  return record;
}

export function retainAnswer(service, record, value) {
  const path = join(service.store.directory, `answer-${randomUUID()}.json`);
  writeJson(path, { issueId: record.issueId, actor: 'human', at: new Date().toISOString(), ...value });
  return path;
}

function validLifecycleLedger(ledger) {
  return ledger.version === 1 && ledger.issues && !Array.isArray(ledger.issues);
}
export function approvedLifecyclePlan(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  return record?.approval ? record.plan : null;
}

function legacyStoppedView(record) {
  if (record.input?.type !== 'retry') return null;
  return { ...record, status: 'blocked', input: null, legacyRetry: true };
}
