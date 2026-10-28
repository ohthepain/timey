import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = dirname(fileURLToPath(import.meta.url));

// Restart and browser assets belong to the installed backend, not the issue project.
export function uiDirectory() {
  return installed;
}

export function factoryEntry() {
  return resolve(installed, '..', 'factory-ui.mjs');
}
