import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJson, requireThat } from './common.mjs';
import { listStoredIssues } from './issue-report-storage.mjs';
import { readSavedReport } from './report-document.mjs';

export function exportIssueReports(root, target) {
  requireThat(typeof target === 'string' && target.length > 0, 'Provide a local export checkout.');
  const destination = join(resolve(target), '.issues');
  requireThat(!existsSync(destination), 'Use an export checkout with no issue folder.');
  const registry = join(root, '.issues/issue-numbers.json');
  const { issues: numbers, next } = readJson(registry);
  const assigned = Object.values(numbers);
  requireThat(
    Number.isSafeInteger(next) &&
      assigned.every((number) => Number.isSafeInteger(number) && number > 0 && number < next) &&
      new Set(assigned).size === assigned.length,
    'The display-number registry needs reconciliation before export.'
  );
  const files = ['open', 'closed'].flatMap((location) =>
    listStoredIssues(root, location).map((path) => ({ path, location, name: basename(path) }))
  );
  const ids = new Set();
  for (const { name, location } of files) {
    const id = basename(name, '.md');
    requireThat(!ids.has(id) && Object.hasOwn(numbers, id), 'Every report needs a unique ID and display number.');
    readSavedReport(root, id, location);
    ids.add(id);
  }
  mkdirSync(join(destination, 'closed'), { recursive: true });
  copyFileSync(registry, join(destination, 'issue-numbers.json'));
  for (const { path, location, name } of files)
    copyFileSync(path, location === 'closed' ? join(destination, 'closed', name) : join(destination, name));
  return {
    destination,
    open: files.filter(({ location }) => location === 'open').length,
    closed: files.filter(({ location }) => location === 'closed').length,
    displayNumbers: assigned.length,
  };
}
