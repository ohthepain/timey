import { digest, requireThat } from './common.mjs';

const defaults = [
  ['Showstopper', 'Orange', 'The system is completely broken or inaccessible.'],
  ['Critical', 'Red', 'Core functionality is broken, heavily degraded, or losing data.'],
  ['Major', 'Yellow', 'A significant feature is broken, but the core workflow still works.'],
  ['Minor', 'Green', 'A small inconvenience that does not break functionality.'],
  ['Suggestion', 'Pink', 'An idea, enhancement, or cosmetic improvement.'],
];
const colors = { orange: '#f97316', red: '#ef4444', yellow: '#eab308', green: '#22c55e', pink: '#ec4899' };
const priorityId = (name) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export function readPriorities(markdown) {
  const section = markdown.match(/^#{1,2} Issue Priorities\s*\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/im)?.[1];
  const rows = section
    ? section
        .split('\n')
        .filter((line) => /^\s*\|/.test(line))
        .map((line) =>
          line
            .split('|')
            .slice(1, 4)
            .map((cell) => cell.replaceAll('`', '').trim())
        )
        .filter((row) => row[0] && !['name', '---'].includes(row[0].toLowerCase()))
    : defaults;
  const choices = rows.map(([name, color, meaning]) => {
    const value = colors[color?.toLowerCase()] || color;
    requireThat(
      name && meaning && /^#[a-f0-9]{6}$/i.test(value),
      'Each issue priority needs a name, supported color or hex color, and meaning in triage-labels.md.'
    );
    return { id: priorityId(name), name, color: value, meaning };
  });
  requireThat(
    choices.some((choice) => choice.id === 'major'),
    'Issue Priorities must include Major, the default.'
  );
  requireThat(
    new Set(choices.map((choice) => choice.id)).size === choices.length,
    'Issue priority names must be unique.'
  );
  return choices;
}
export function priorityView(issue, choices) {
  const id = priorityId(String(issue.priority || 'Major'));
  const index = choices.findIndex((choice) => choice.id === id);
  return {
    ...(choices[index] || {
      id,
      name: issue.priority,
      color: '#94a3b8',
      meaning: 'This saved priority is not in the project list.',
    }),
    index,
    basis: digest(JSON.stringify({ id: issue.id, priority: id, choices })),
  };
}
