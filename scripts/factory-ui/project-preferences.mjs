import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, requireThat, writeJson } from './common.mjs';
import { projectChatPrompt, issueChatPrompt } from './project-prompt-defaults.mjs';

const preferencesFile = 'user/factory-preferences.json';
const defaultSource = 'scripts/factory-ui/project-prompt-defaults.mjs';
const promptDefaults = {
  project: projectChatPrompt,
  issue: issueChatPrompt,
  report: projectChatPrompt,
  investigation: issueChatPrompt,
};
const hotkeyDefaults = { dictateHot: 'Alt+D', dictateCold: '', newNote: 'Alt+N', newIssue: 'N' };
const promptsSchema = z
  .object(
    Object.fromEntries(
      Object.keys(promptDefaults).map((key) => [key, z.string().min(1).max(24000).nullable().optional()])
    )
  )
  .strict();
const hotkeysSchema = z
  .object(Object.fromEntries(Object.keys(hotkeyDefaults).map((key) => [key, z.string().max(80).optional()])))
  .strict();
const settingsSchema = z.object({ prompts: promptsSchema.optional(), hotkeys: hotkeysSchema.optional() }).strict();
const saveSchema = settingsSchema.extend({ revision: z.string() });
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const aliases = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
};
const namedKeys = [
  'Enter',
  'Escape',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

export function normalizeFactoryHotkey(value) {
  if (!value.trim()) return '';
  const tokens = value.split('+').map((token) => token.trim());
  const keyToken = tokens.pop();
  const keys = namedKeys.find((name) => name.toLowerCase() === keyToken.toLowerCase());
  const key = /^(?:[a-z0-9]|F(?:[1-9]|1\d|2[0-4]))$/i.test(keyToken) ? keyToken.toUpperCase() : keys;
  const selected = tokens.map((token) => aliases[token.toLowerCase()]);
  requireThat(
    [key, ...selected].every(Boolean) && new Set(selected).size === selected.length,
    'Use a key combination such as Alt+D or Ctrl+Shift+N. Leave it empty to disable it.'
  );
  return [...modifiers.filter((modifier) => selected.includes(modifier)), key].join('+');
}

function normalizedHotkeys(values) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeFactoryHotkey(value)])
  );
  const bound = Object.values(normalized).filter(Boolean);
  requireThat(
    new Set(bound).size === bound.length,
    'Factory hotkeys must be distinct. Change the duplicate combination before saving.'
  );
  return normalized;
}

function readPreferences(root) {
  const path = join(root, preferencesFile);
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const settings = source ? settingsSchema.parse(JSON.parse(source)) : {};
  return { settings, revision: digest(source) };
}

export function readProjectPreferences(root) {
  const { settings, revision } = readPreferences(root);
  return {
    revision,
    prompts: Object.fromEntries(
      Object.entries(promptDefaults).map(([key, fallback]) => {
        const overridden = typeof settings.prompts?.[key] === 'string';
        return [
          key,
          {
            value: overridden ? settings.prompts[key] : fallback,
            default: fallback,
            source: overridden ? preferencesFile : defaultSource,
            overridden,
          },
        ];
      })
    ),
    hotkeys: {
      values: normalizedHotkeys({ ...hotkeyDefaults, ...settings.hotkeys }),
      defaults: { ...hotkeyDefaults },
      source: settings.hotkeys ? preferencesFile : 'scripts/factory-ui/project-preferences.mjs',
    },
  };
}

export function effectiveProjectPrompt(root, kind) {
  return readProjectPreferences(root).prompts[kind].value;
}

function updatedPreferences(current, changes) {
  const next = { ...current };
  if (changes.prompts)
    next.prompts = Object.fromEntries(
      Object.entries({ ...next.prompts, ...changes.prompts }).filter(([, value]) => value !== null)
    );
  if (changes.hotkeys) next.hotkeys = normalizedHotkeys({ ...hotkeyDefaults, ...next.hotkeys, ...changes.hotkeys });
  return next;
}

export function saveProjectPreferences(service, input) {
  service.ownServer();
  const changes = saveSchema.parse(input);
  const current = readPreferences(service.root);
  requireThat(changes.revision === current.revision, 'Project settings changed. Reload Settings before saving.');
  const next = updatedPreferences(current.settings, changes);
  const directory = join(service.root, 'user');
  const path = join(service.root, preferencesFile);
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  const fileStat = lstatSync(path, { throwIfNoEntry: false });
  requireThat(!directoryStat || directoryStat.isDirectory(), 'Project preferences need an ordinary user directory.');
  requireThat(!fileStat || fileStat.isFile(), 'Project preferences need an ordinary configuration file.');
  mkdirSync(directory, { recursive: true });
  writeJson(path, next);
  return readProjectPreferences(service.root);
}
