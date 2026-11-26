import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';
import { readFolderSettings, requireIssueFolder, updateFolderSettings } from './issue-folder-settings.mjs';

const builtins = [
  { id: 'sequential', name: 'Sequential', prompt: 'Select issues to work on in the displayed order.' },
  {
    id: 'same-blast-radius',
    name: 'Same blast radius',
    prompt:
      'Select issues with a concrete overlap in behavior or code. Explain the overlap and any checks they could share.',
  },
  {
    id: 'different-blast-radii',
    name: 'Different blast radii',
    prompt:
      'Select independent issues that are unlikely to affect the same behavior or code or depend on one another. Explain why each could progress independently.',
  },
];

function userStrategies(project) {
  const directory = join(project, 'user', 'selection-strategies');
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !/^[\w-]+\.md$/.test(entry.name)) return [];
    const path = join(directory, entry.name);
    if (lstatSync(path).size > 128000) return [];
    const prompt = readFileSync(path, 'utf8');
    return [
      {
        id: 'user/selection-strategies/' + entry.name,
        name: prompt.match(/^#\s+(.+)$/m)?.[1] || entry.name.slice(0, -3),
        prompt,
      },
    ];
  });
}

export function folderStrategy(project, id) {
  const strategy = [...builtins, ...userStrategies(project)].find((entry) => entry.id === id);
  requireThat(strategy, 'Choose an available selection strategy.');
  return strategy;
}

export function folderStrategies(project, folder) {
  const entry = requireIssueFolder(project, folder);
  const view = readFolderSettings(project, entry.directory);
  return {
    strategies: [...builtins, ...userStrategies(project)].map(({ prompt, ...strategy }) => strategy),
    selected: view.settings.selection_strategy.value,
    revision: view.revision,
  };
}

export function changeFolderStrategy(project, input) {
  const entry = requireIssueFolder(project, input.folder);
  const view = readFolderSettings(project, entry.directory);
  requireThat(view.revision === input.revision, 'The folder settings changed. Refresh before selecting a strategy.');
  requireThat(['select', 'copy'].includes(input.action), 'Choose Select or Copy strategy.');
  let strategy = folderStrategy(project, input.strategy);
  if (input.action === 'copy') {
    const directory = join(project, 'user', 'selection-strategies');
    mkdirSync(directory, { recursive: true });
    requireThat(
      lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
      'Choose an ordinary user strategy directory.'
    );
    const name =
      strategy.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'strategy';
    const file = name + '-' + randomUUID().slice(0, 8) + '.md';
    const text = strategy.prompt.startsWith('# ')
      ? strategy.prompt
      : '# ' + strategy.name + '\n\n' + strategy.prompt + '\n';
    writeFileSync(join(directory, file), text, { flag: 'wx' });
    strategy = { ...strategy, id: 'user/selection-strategies/' + file };
  }
  updateFolderSettings(project, {
    directory: entry.directory,
    revision: view.revision,
    changes: { selection_strategy: strategy.id },
  });
  return folderStrategies(project, input.folder);
}
