import { requireThat } from './common.mjs';

// Used by older projects until they add a Closed reasons table to triage-labels.md.
const defaults = [
  ['fixed', 'Fixed', 'The change is verified and accepted.'],
  ['wont-do', 'Won’t Do', 'We have decided not to do this work.'],
  ['duplicate', 'Duplicate', 'Another issue tracks the same work.'],
  ['cannot-reproduce', 'Cannot Reproduce', 'We tried but could not reproduce the reported behavior.'],
  ['incomplete', 'Not Enough Information', 'The report lacks information needed to investigate.'],
  ['obsolete', 'No Longer Relevant', 'The feature or circumstances have changed.'],
];
export function closureReasons(markdown) {
  const section = markdown.match(/^#{1,2} Closed reasons\s*\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/im)?.[1];
  if (!section) return defaults.map(([id, label, description]) => ({ id, label, description }));
  const rows = section
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.replaceAll('`', '').trim()))
    .filter((cells) => cells.length >= 5 && /^[a-z][a-z0-9-]*$/.test(cells[1]) && cells[1] !== 'id');
  requireThat(rows.length > 0, 'Add an ID, Label and Meaning table under Closed reasons in .issues/triage-labels.md.');
  requireThat(new Set(rows.map((row) => row[1])).size === rows.length, 'Closure reason IDs must be unique.');
  return rows.map(([, id, label, description]) => {
    requireThat(label && description, 'Each closure reason needs a label and meaning.');
    return { id, label, description };
  });
}
