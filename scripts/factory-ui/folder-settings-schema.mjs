import { providerModelChoices, providerModelMetadata } from './provider-runtime.mjs';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { uiDirectory } from './ui-source.mjs';
import { requireThat } from './common.mjs';
import { storageProfileChoices, readStoreConfig } from './stores/config.mjs';

const info = (path) => lstatSync(path, { throwIfNoEntry: false });
const reference = resolve(uiDirectory(), '../../factory/system/folder.md');
const branchValidation = new Map();
let registry;

function directoryChoices(directory, predicate) {
  if (!info(directory)?.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => predicate(entry, join(directory, entry.name)))
    .map(({ name }) => ({ value: name, label: name }));
}

function personalSkillsDirectory() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
}

function dynamicChoices(project, kind) {
  if (kind === 'storage-profile') return storageProfileChoices(project);
  if (kind === 'skill')
    return [
      resolve(uiDirectory(), '../../.agents/skills'),
      join(project, 'user/skills'),
      join(project, '.agents/skills'),
      personalSkillsDirectory(),
    ].flatMap((directory) =>
      directoryChoices(
        directory,
        (entry, path) => (entry.isDirectory() || entry.isSymbolicLink()) && info(join(path, 'SKILL.md'))?.isFile()
      )
    );
  if (kind === 'strategy')
    return directoryChoices(
      join(project, 'user/selection-strategies'),
      (entry) => entry.isFile() && entry.name.endsWith('.md')
    ).map(({ value, label }) => ({ value: 'user/selection-strategies/' + value, label }));
  if (kind === 'branch') {
    try {
      return execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        cwd: project,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((value) => ({ value, label: value }));
    } catch {
      return [];
    }
  }
  return [];
}

export function folderSettingsFields(project, { branchChoices = true } = {}) {
  const modified = info(reference).mtimeMs;
  if (registry?.modified !== modified) {
    const text = readFileSync(reference, 'utf8');
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    registry = { modified, data: header && parse(header[1], { maxAliasCount: 0 }) };
  }
  const data = registry.data;
  requireThat(data?.fields && typeof data.fields === 'object', 'Restore the system folder settings reference.');
  return Object.entries(data.fields).map(([key, field]) => {
    requireThat(
      typeof field.label === 'string' && typeof field.fallback === 'string',
      'The system folder settings reference has an invalid field.'
    );
    const choices = [
      ...(key === 'model' ? (providerModelChoices(project) ?? field.choices ?? []) : field.choices || []),
      ...(field.kind === 'branch' && !branchChoices ? [] : dynamicChoices(project, field.kind)),
    ];
    return {
      key,
      ...field,
      ...(key === 'model' ? { availability: providerModelMetadata(project) } : {}),
      ...(field.kind === 'storage-profile'
        ? { fallback: readStoreConfig(project).profileDefault, fallbackSource: 'Project storage profile default' }
        : {}),
      choices: choices.filter(({ value }, index) => choices.findIndex((entry) => entry.value === value) === index),
    };
  });
}

export function validateSettingValue(
  project,
  key,
  value,
  fields = folderSettingsFields(project, { branchChoices: false })
) {
  return validateFieldValue(
    fields.find((entry) => entry.key === key),
    value
  );
}

export function validateFieldValue(field, value) {
  if (!field) return 'Choose a supported folder setting.';
  if (value === 'default') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    return field.label + ' needs a value or default.';
  if (field.key === 'model' && field.availability && Object.hasOwn(field.availability, value)) return null;
  if (field.kind === 'branch') {
    if (branchValidation.has(value)) return branchValidation.get(value);
    try {
      execFileSync('git', ['check-ref-format', '--branch', value], {
        encoding: 'utf8',
        stdio: 'ignore',
        timeout: 2000,
      });
      branchValidation.set(value, null);
      return null;
    } catch {
      branchValidation.set(value, 'Choose a valid target branch.');
      return branchValidation.get(value);
    }
  }
  return field.choices.some((entry) => entry.value === value)
    ? null
    : 'Choose a listed ' + field.label.toLowerCase() + ' or default.';
}

function isSettingsMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFolderStorageSettings(data) {
  if (!isSettingsMap(data)) return data;
  if (!Object.hasOwn(data, 'issue_store')) return data;
  const { issue_store: legacy, ...settings } = data;
  return { storage_profile: legacy, ...settings };
}
