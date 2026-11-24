import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const flowMeasurements = new Set([
  'activity-indicator.json',
  'ai-text-controls.json',
  'browser.log.json',
  'closed-issues-action.json',
  'github-refresh-on-demand.json',
  'issue-scrollbar.json',
  'issue-status-carets.json',
  'local-note-issue-number.json',
  'local-notes-disclosure.json',
  'manual-close.json',
  'merged-issue-readonly.json',
  'project-discuss-dictation.json',
  'project-discuss-scroll.json',
  'project-discuss-tabs.json',
  'pulse-sidebar.json',
  'report-draft-restore.json',
  'sidebar-scroll.json',
]);

const screenshotOrResult = (name) => /^[\w-]+\.png$/.test(name) || name === 'results.json';
const outputRules = [
  [
    '',
    (name) =>
      screenshotOrResult(name) ||
      /^(?:(?:reload-)?(?:factory-browser-|browser-scenarios-)[\w-]+\.mjs|open|close)\.log$/.test(name),
  ],
  [
    'flow',
    (name) => screenshotOrResult(name) || /^[\w-]+-(?:styles|proof)\.json$/.test(name) || flowMeasurements.has(name),
  ],
];

export function retainBrowserEvidence(output, retained) {
  if (!lstatSync(output, { throwIfNoEntry: false })?.isDirectory()) return [];
  return outputRules.flatMap(([directory, declared]) => {
    const source = join(output, directory);
    if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) return [];
    const destination = join(retained, directory);
    mkdirSync(destination, { recursive: true });
    return readdirSync(source, { withFileTypes: true })
      .filter((file) => file.isFile() && declared(file.name))
      .map((file) => file.name)
      .sort()
      .map((name) => {
        const bytes = readFileSync(join(source, name));
        const path = join(destination, name);
        writeFileSync(path, bytes, { flag: 'wx' });
        return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
  });
}
