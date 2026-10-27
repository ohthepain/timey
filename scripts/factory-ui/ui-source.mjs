import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = dirname(fileURLToPath(import.meta.url));

export function uiDirectory(service) {
  if (service.reviewMode === 'preview') return installed;
  const project = join(service.root, 'scripts/factory-ui');
  if (existsSync(join(project, 'index.html'))) return project;
  return installed;
}

export function factoryEntry(service) {
  if (service.reviewMode === 'preview') return process.argv[1];
  const project = join(service.root, 'scripts/factory-ui.mjs');
  if (existsSync(project)) return project;
  return process.argv[1];
}
