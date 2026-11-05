import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { digest, requireThat, writeJson } from './common.mjs';

const orderPath = (root) => join(root, '.issues', 'implementation-order.json');

function priorityRank(issue) {
  const rank = issue.priorityInfo?.index;
  return rank >= 0 ? rank : Number.MAX_SAFE_INTEGER;
}

function compareDefaultOrder(a, b) {
  return comparePriority(a, b) || compareAge(a, b) || a.id.localeCompare(b.id);
}

function comparePriority(a, b) {
  return priorityRank(a) - priorityRank(b);
}

function compareAge(a, b) {
  return (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0);
}

function defaultOrder(issues) {
  const ordered = issues.slice().sort(compareDefaultOrder);
  return ordered.map((issue) => issue.id);
}

export function implementationOrder(issues, saved = []) {
  const available = new Set(issues.map((issue) => issue.id));
  const seen = new Set();
  const ordered = [];
  appendSaved(ordered, seen, available, saved);
  appendDefaults(ordered, seen, defaultOrder(issues));
  return ordered;
}

export function changeImplementationOrder(service, input) {
  service.ownServer();
  const queue = readQueue(service.root);
  return persistImplementationOrder(service.root, queue, input);
}

function appendSaved(ordered, seen, available, saved) {
  for (const id of saved) appendIfCurrent(ordered, seen, available, id);
}

function appendDefaults(ordered, seen, defaults) {
  for (const id of defaults) appendIfCurrent(ordered, seen, null, id);
}

function appendIfCurrent(ordered, seen, available, id) {
  if ((available && !available.has(id)) || seen.has(id)) return;
  seen.add(id);
  ordered.push(id);
}

export function persistImplementationOrder(root, queue, input) {
  const current = queue.implementationOrder;
  const issueIds = queue.issues.map((issue) => issue.id).sort();
  const basis = digest(JSON.stringify({ issueIds, order: current }));
  requireThat(input.basis === basis, 'The issue queue changed. Refresh before reordering it.');
  requireThat(
    Array.isArray(input.order) &&
      input.order.length === current.length &&
      new Set(input.order).size === current.length &&
      input.order.every((id) => issueIds.includes(id)),
    'The implementation order must include each current issue exactly once.'
  );
  writeJson(orderPath(root), { version: 1, issues: input.order });
  return { order: input.order };
}

export function readImplementationOrder(root, issues) {
  const path = orderPath(root);
  if (!existsSync(path)) return implementationOrder(issues);
  return implementationOrder(issues, readSavedOrder(path));
}

function readSavedOrder(path) {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.version === 1 && Array.isArray(saved.issues)) return saved.issues;
  } catch {
    return [];
  }
  return [];
}
