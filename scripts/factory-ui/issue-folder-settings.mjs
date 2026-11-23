import {
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  rmdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { digest, requireThat } from './common.mjs';
import { requireAvailableDirectory } from './folder-trash.mjs';
import {
  folderSettingsFields,
  validateSettingValue,
  validateFieldValue,
  normalizeFolderStorageSettings,
} from './folder-settings-schema.mjs';
import { uiDirectory } from './ui-source.mjs';

export { validateSettingValue } from './folder-settings-schema.mjs';
const settingsName = 'folder.md';
export const inboxFolderId = '759bf44b-f95a-417b-99e3-b4a1dd31555c';
const folderId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const stat = (path) => lstatSync(path, { throwIfNoEntry: false });
const skipped = new Set(['node_modules', '.git', '.issues', '.aws', '.ssh']);
const installed = [resolve(uiDirectory(), '../../factory/system'), resolve(uiDirectory(), '../../.agents/skills')];
const within = (root, directory) => directory === root || directory.startsWith(root + sep);
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function segments(name) {
  requireThat(
    typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 200,
    'Use a folder path under 200 characters.'
  );
  const parts = name.split('/');
  requireThat(
    parts.every((part) => part && !part.startsWith('.') && !/[\\:\x00-\x1f]/.test(part)),
    'Choose a regular project folder.'
  );
  return parts;
}

function ordinaryPath(root, directory, allowMissing = false) {
  const absolute = isAbsolute(directory) ? resolve(directory) : resolve(root, directory);
  requireThat(within(root, absolute), 'Choose a folder inside the project.');
  let path = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    requireThat(!skipped.has(part), 'Choose a folder outside runtime storage.');
    path = join(path, part);
    const file = stat(path);
    requireThat(file?.isDirectory() || (allowMissing && !file), 'Choose an ordinary project folder without symlinks.');
  }
  return absolute;
}

function ownedDirectory(root, directory) {
  return within(root, directory) && !installed.some((base) => within(base, directory));
}

function descriptor(root, directory, id = null) {
  const projectPath = relative(root, directory).split(sep).join('/');
  const name = projectPath.startsWith('user/') ? projectPath.slice(5) : '/' + projectPath;
  return { id, name, label: basename(directory), projectPath, directory };
}

function normalizedStorageDocument(doc) {
  const data = doc.toJS({ maxAliasCount: 0 });
  if (!plainObject(data)) return data;
  if (!Object.hasOwn(data, 'issue_store')) return data;
  if (!Object.hasOwn(data, 'storage_profile')) doc.set('storage_profile', doc.get('issue_store', true));
  doc.delete('issue_store');
  return normalizeFolderStorageSettings(data);
}

function readDocument(directory) {
  const path = join(directory, settingsName);
  const file = stat(path);
  if (!file) return { exists: false, source: '', errors: [], path };
  if (!file.isFile() || file.size > 128000)
    return {
      exists: true,
      source: '',
      path,
      errors: [{ key: 'file', message: 'Use an ordinary folder.md file under 128 KB.' }],
    };
  const source = readFileSync(path, 'utf8');
  const header = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!header)
    return { exists: true, source, path, errors: [{ key: 'file', message: 'folder.md needs YAML frontmatter.' }] };
  const doc = parseDocument(header[2], { maxAliasCount: 0, uniqueKeys: true });
  const errors = doc.errors.map((error) => ({ key: 'file', message: error.message }));
  let data;
  try {
    data = normalizedStorageDocument(doc);
  } catch (error) {
    errors.push({ key: 'file', message: error.message });
  }
  if (!plainObject(data)) errors.push({ key: 'file', message: 'Folder settings must be a YAML map.' });
  return { exists: true, source, path, header, doc, data: plainObject(data) ? data : {}, errors };
}

function basicSettings(directory) {
  const record = readDocument(directory);
  if (!record.exists) return null;
  let id = record.data?.id;
  if (!folderId.test(typeof id === 'string' ? id : '')) {
    const matches = [...(record.header?.[2] || '').matchAll(/^id:\s*["']?([\da-f-]{36})["']?\s*(?:#.*)?$/gm)];
    id = matches.length === 1 && folderId.test(matches[0][1]) ? matches[0][1] : null;
  }
  return {
    id,
    description: record.data?.description,
    isDefaultFolder: record.data?.is_default_folder === true,
    settingsErrors: [
      ...record.errors,
      ...(!id ? [{ key: 'id', message: 'Restore the stable folder ID before assigning issues.' }] : []),
    ],
  };
}

function roots(root) {
  const result = [join(root, 'user')];
  const path = join(root, '.issues/sidebar-files.local.json');
  if (!stat(path)?.isFile()) return result;
  const pins = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(pins)) return result;
  for (const pin of pins) {
    if (typeof pin.base !== 'string' || !stat(pin.base)?.isDirectory()) continue;
    try {
      const base = realpathSync(pin.base);
      if (ownedDirectory(root, base) && base !== root) result.push(ordinaryPath(root, base));
    } catch {
      /* Invalid pins do not grant access. */
    }
  }
  return [...new Set(result)];
}

export function readIssueFolderSettings(project, { includeCopies = false, includeBroken = false } = {}) {
  const root = realpathSync(project);
  const folders = [];
  const visited = new Set();
  function visit(directory) {
    if (visited.has(directory) || !stat(directory)?.isDirectory() || !ownedDirectory(root, directory)) return;
    visited.add(directory);
    const data = basicSettings(directory);
    if (data) folders.push({ ...descriptor(root, directory, data.id), ...data });
    for (const item of readdirSync(directory, { withFileTypes: true }))
      if (item.isDirectory() && !item.name.startsWith('.') && !skipped.has(item.name))
        visit(join(directory, item.name));
  }
  for (const directory of roots(root)) visit(directory);
  const counts = new Map();
  for (const { id } of folders) if (id) counts.set(id, (counts.get(id) || 0) + 1);
  return folders
    .map((folder) => ({ ...folder, duplicate: Boolean(folder.id && counts.get(folder.id) > 1) }))
    .filter((folder) => (folder.id || includeBroken) && (includeCopies || !folder.duplicate));
}

function scope(project, directory) {
  const root = realpathSync(project);
  const requested = isAbsolute(directory) ? resolve(directory) : resolve(root, directory);
  const absolute = within(resolve(project), requested)
    ? resolve(root, relative(resolve(project), requested))
    : requested;
  const canConfigure =
    ownedDirectory(root, absolute) && (absolute === root || roots(root).some((base) => within(base, absolute)));
  if (canConfigure) ordinaryPath(root, absolute);
  return { root, directory: absolute, canConfigure };
}

function fieldErrors(data, fields) {
  const errors = [];
  for (const field of fields) {
    const { key } = field;
    if (!Object.hasOwn(data, key)) continue;
    const message = validateFieldValue(field, data[key]);
    if (message) errors.push({ key, message });
  }
  return errors;
}

function inheritedField(root, chain, field) {
  const fallback = { value: field.fallback, source: field.fallbackSource || 'Factory built-in' };
  for (const { record } of chain) {
    if (!record.exists) continue;
    if (record.errors.length)
      return {
        ...fallback,
        error: {
          key: field.key,
          message: `Repair ${relative(root, record.path)} before inheriting ${field.label.toLowerCase()}.`,
        },
      };
    const value = record.data[field.key];
    if (value === undefined || value === 'default') continue;
    const message = validateFieldValue(field, value);
    if (message)
      return {
        ...(field.key === 'model' ? { value, source: relative(root, record.path) } : fallback),
        error: { key: field.key, message },
      };
    return { value, source: relative(root, record.path).split(sep).join('/') };
  }
  return fallback;
}

function inheritedSettings(root, directory, record, fields) {
  const chain = [{ directory, record }];
  let parent = directory;
  while (parent !== root) {
    parent = dirname(parent);
    chain.push({ directory: parent, record: readDocument(parent) });
  }
  const settings = {};
  const errors = [];
  for (const field of fields) {
    const resolved = inheritedField(root, chain, field);
    if (resolved.error) errors.push(resolved.error);
    settings[field.key] = {
      raw: Object.hasOwn(record.data || {}, field.key) ? record.data[field.key] : 'default',
      value: resolved.value,
      source: resolved.source,
    };
  }
  return { settings, errors };
}

function metadataErrors(record, folder, folders, project) {
  if (folder.directory === project) return [];
  const errors = [];
  if (!folder.id) errors.push({ key: 'id', message: 'Restore the stable folder ID before assigning issues.' });
  if (folder.id && folders.filter((entry) => entry.id === folder.id).length > 1)
    errors.push({ key: 'id', message: 'This folder shares its ID with another folder. Give the copy a new ID.' });
  if (record.data?.description !== undefined && typeof record.data.description !== 'string')
    errors.push({ key: 'description', message: 'The folder description must be text.' });
  if (record.data?.is_default_folder !== undefined && typeof record.data.is_default_folder !== 'boolean')
    errors.push({ key: 'is_default_folder', message: 'Is default folder must be true or false.' });
  const defaults = folders.filter((entry) => entry.isDefaultFolder);
  if (defaults.length !== 1)
    errors.push({
      key: 'is_default_folder',
      message: defaults.length
        ? 'Several folders are marked as default. Choose one default folder.'
        : 'Choose a default issue folder.',
    });
  return errors;
}

export function readFolderSettings(project, directory, { branchChoices = true, snapshot } = {}) {
  const location = scope(project, directory);
  const { root, canConfigure } = location;
  requireThat(!snapshot || snapshot.root === root, 'The folder snapshot belongs to another project.');
  const fields = snapshot?.fields ?? folderSettingsFields(root, { branchChoices });
  const record = canConfigure ? readDocument(location.directory) : { exists: false, source: '', errors: [] };
  const basic = record.exists ? basicSettings(location.directory) : null;
  const folder = descriptor(root, location.directory, basic?.id);
  const revision = digest(JSON.stringify([location.directory, record.source]));
  if (!record.exists)
    return {
      kind: 'plain',
      folder,
      revision,
      fields,
      settings: {},
      missing: fields.map(({ key }) => key),
      errors: [],
      isDefaultFolder: false,
      canConfigure,
      repairable: false,
    };
  const inherited = inheritedSettings(root, location.directory, record, fields);
  const folders = snapshot?.folders ?? readIssueFolderSettings(root, { includeCopies: true, includeBroken: true });
  const errors = [
    ...record.errors,
    ...fieldErrors(record.data || {}, fields),
    ...inherited.errors,
    ...metadataErrors(record, folder, folders, root),
  ];
  return {
    kind: errors.length ? 'broken' : location.directory === root ? 'project' : 'configured',
    folder,
    revision,
    fields,
    settings: inherited.settings,
    missing: fields.filter(({ key }) => !Object.hasOwn(record.data || {}, key)).map(({ key }) => key),
    errors: errors.filter(
      (error, index) =>
        errors.findIndex((entry) => entry.key === error.key && entry.message === error.message) === index
    ),
    isDefaultFolder: basic?.isDefaultFolder || false,
    canConfigure,
    repairable: !record.errors.length && Boolean(record.doc),
  };
}

function nameDirectory(root, name, allowMissing = false) {
  const absolute = name.startsWith('/')
    ? join(root, ...segments(name.slice(1)))
    : join(root, 'user', ...segments(name));
  requireThat(ownedDirectory(root, absolute), 'Installed folders cannot contain project issue settings.');
  return ordinaryPath(root, absolute, allowMissing);
}

function newSettings(fields, id, values = {}) {
  const lines = [
    '---',
    ...(id
      ? [
          'id: ' + id,
          '# is_default_folder is folder-specific and is not an inherited system field.',
          'is_default_folder: false',
        ]
      : []),
  ];
  for (const field of fields) lines.push(field.key + ': ' + JSON.stringify(values[field.key] ?? 'default'));
  return lines.join('\n') + '\n---\n';
}

export function createIssueFolderSettings(project, name, { id: requestedId } = {}) {
  const root = realpathSync(project);
  requireThat(
    requestedId === undefined || (typeof requestedId === 'string' && folderId.test(requestedId)),
    'Use a valid stable folder ID.'
  );
  const directory = nameDirectory(root, name, true);
  requireThat(
    roots(root).some((base) => within(base, directory)),
    'Choose a project-owned sidebar folder.'
  );
  requireAvailableDirectory(directory);
  mkdirSync(directory, { recursive: true });
  const configured = basicSettings(directory);
  if (configured) {
    requireThat(
      configured.id && !configured.settingsErrors.length,
      'Repair the existing folder.md rather than replacing it.'
    );
    requireThat(
      readIssueFolderSettings(root).some((folder) => folder.id === configured.id),
      'This folder shares its ID with another folder. Give the copy a new ID.'
    );
    return { ...descriptor(root, directory, configured.id), ...configured };
  }
  const id = requestedId || (name === 'Inbox' ? inboxFolderId : randomUUID());
  writeFileSync(join(directory, settingsName), newSettings(folderSettingsFields(root), id), { flag: 'wx' });
  return { ...descriptor(root, directory, id), id };
}

function replaceDocument(record, doc) {
  const yaml = doc.toString().trimEnd().replaceAll('\n', record.header[1].slice(3));
  const text = record.header[1] + yaml + record.header[3] + record.source.slice(record.header[0].length);
  const temp = record.path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: stat(record.path).mode & 0o777 });
    requireThat(
      readFileSync(record.path, 'utf8') === record.source,
      'The settings changed. Reopen them before saving.'
    );
    renameSync(temp, record.path);
  } finally {
    if (stat(temp)) unlinkSync(temp);
  }
}

function settingsLock(root, action) {
  const queue = join(root, '.issues');
  requireThat(!stat(queue) || stat(queue).isDirectory(), 'The issue directory must be an ordinary directory.');
  mkdirSync(queue, { recursive: true });
  const lock = join(queue, 'factory.lock');
  requireThat(!stat(lock), 'Wait for the active queue operation before changing folder settings.');
  mkdirSync(lock);
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

function applyChanges(root, directory, view, changes) {
  const record = readDocument(directory);
  requireThat(record.doc && !record.errors.length, 'Open folder.md to repair its YAML syntax first.');
  for (const [key, value] of Object.entries(changes)) {
    requireThat(
      view.fields.some((field) => field.key === key),
      'Choose a supported inherited setting.'
    );
    const message = validateSettingValue(root, key, value, view.fields);
    requireThat(!message, message);
    record.doc.set(key, value);
  }
  return record;
}

function changeDefault(root, directory, record, makeDefault) {
  if (makeDefault === undefined) return;
  requireThat(typeof makeDefault === 'boolean' && directory !== root, 'Choose an issue folder as the default.');
  requireThat(basicSettings(directory)?.id, 'Restore the stable folder ID before selecting the default.');
  const folders = readIssueFolderSettings(root, { includeCopies: true, includeBroken: true });
  requireThat(
    !folders.find((entry) => entry.directory === directory)?.duplicate,
    'Give the copied folder a unique ID before selecting the default.'
  );
  requireThat(
    makeDefault || folders.some((entry) => entry.directory !== directory && entry.isDefaultFolder),
    'Choose a replacement before removing the default issue folder.'
  );
  if (makeDefault)
    for (const folder of folders) {
      if (folder.directory === directory || !folder.isDefaultFolder) continue;
      const other = readDocument(folder.directory);
      requireThat(!other.errors.length, 'Repair the other default folder before switching defaults.');
      other.doc.set('is_default_folder', false);
      replaceDocument(other, other.doc);
    }
  record.doc.set('is_default_folder', makeDefault);
}

export function updateFolderSettings(project, { directory, revision, changes = {}, makeDefault }) {
  const { root, directory: target, canConfigure } = scope(project, directory);
  requireThat(canConfigure, 'Only project-owned folders can be configured.');
  requireAvailableDirectory(target);
  requireThat(plainObject(changes), 'Provide the changed settings.');
  return settingsLock(root, () => {
    const view = readFolderSettings(root, target);
    requireThat(view.revision === revision, 'The settings changed. Reopen them before saving.');
    requireThat(view.kind !== 'plain', 'Create folder.md before editing settings.');
    const record = applyChanges(root, target, view, changes);
    changeDefault(root, target, record, makeDefault);
    replaceDocument(record, record.doc);
    return readFolderSettings(root, target);
  });
}

export function previewFolderRepair(project, directory) {
  const view = readFolderSettings(project, directory);
  const changes = Object.fromEntries(view.missing.map((key) => [key, 'default']));
  for (const error of view.errors)
    if (view.fields.some((field) => field.key === error.key)) changes[error.key] = 'default';
  return { revision: view.revision, changes, errors: view.errors, repairable: view.repairable };
}

export function repairFolderSettings(project, input) {
  return updateFolderSettings(project, input);
}

export function giveIssueFolderCopyNewId(project, name) {
  const root = realpathSync(project);
  const folder = readIssueFolderSettings(root, { includeCopies: true }).find((item) => item.name === name);
  requireThat(folder?.duplicate, 'Choose the copied folder that shares an ID.');
  return settingsLock(root, () => {
    const record = readDocument(folder.directory);
    requireThat(
      !record.errors.length && record.data.id === folder.id,
      'Restore the folder settings before giving it a new ID.'
    );
    const id = randomUUID();
    record.doc.set('id', id);
    replaceDocument(record, record.doc);
    return { id };
  });
}

export function requireIssueFolder(project, name, folders) {
  requireThat(typeof name === 'string' && name.trim(), 'Choose a folder for the issue.');
  const folder = (folders ?? readIssueFolderSettings(project)).find(
    (entry) => entry.id && !entry.duplicate && entry.name === name
  );
  requireThat(folder, 'Choose an existing issue folder.');
  requireAvailableDirectory(folder.directory);
  return folder;
}

export function ensureInboxFolder(project) {
  return (
    readIssueFolderSettings(project).find((folder) => folder.id === inboxFolderId || folder.name === 'Inbox') || {
      name: 'Inbox',
      ...createIssueFolderSettings(project, 'Inbox'),
    }
  );
}

export function defaultIssueFolder(
  project,
  { folders = readIssueFolderSettings(project, { includeCopies: true, includeBroken: true }) } = {}
) {
  const defaults = folders.filter((folder) => folder.isDefaultFolder);
  requireThat(
    defaults.length === 1 && defaults[0].id && !defaults[0].duplicate && !defaults[0].settingsErrors.length,
    'Choose exactly one valid default issue folder.'
  );
  requireAvailableDirectory(defaults[0].directory);
  return defaults[0];
}

function jsonFile(path) {
  return stat(path)?.isFile() ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function initialProjectValues(root, fields) {
  const values = Object.fromEntries(fields.map((field) => [field.key, field.fallback]));
  const config = jsonFile(join(root, 'factory.config.json'));
  const defaults = jsonFile(join(root, '.issues/model-settings.json')).defaults || {};
  const delivery = jsonFile(join(root, '.issues/issue-delivery-config.json'));
  return {
    ...values,
    branch: [delivery.target, values.branch].find(Boolean),
    model: [defaults.model, config.factoryModel, values.model].find(Boolean),
    effort: [defaults.effort, config.factoryEffort, values.effort].find(Boolean),
  };
}

export function initializeFolderSettings(project) {
  const root = realpathSync(project);
  if (stat(join(root, settingsName))) return readFolderSettings(root, root);
  requireThat(
    !stat(join(root, '.issues')) || stat(join(root, '.issues')).isDirectory(),
    'The issue directory must be an ordinary directory.'
  );
  const inbox = ensureInboxFolder(root);
  const fields = folderSettingsFields(root);
  const values = initialProjectValues(root, fields);
  if (
    !readIssueFolderSettings(root, { includeCopies: true, includeBroken: true }).some(
      (folder) => folder.isDefaultFolder
    )
  ) {
    const view = readFolderSettings(root, inbox.directory);
    updateFolderSettings(root, { directory: inbox.directory, revision: view.revision, makeDefault: true });
  }
  writeFileSync(join(root, settingsName), newSettings(fields, null, values), { flag: 'wx' });
  return readFolderSettings(root, root);
}

export function resolveFolderSettings(project, name, { snapshot } = {}) {
  const root = realpathSync(project);
  requireThat(!snapshot || snapshot.root === root, 'The folder snapshot belongs to another project.');
  const directory = name ? requireIssueFolder(project, name, snapshot?.folders).directory : root;
  const view = snapshot?.read
    ? snapshot.read(directory)
    : readFolderSettings(project, directory, { branchChoices: false });
  if (view.kind === 'plain') {
    const fields = snapshot?.fields ?? folderSettingsFields(project);
    return {
      values: initialProjectValues(project, fields),
      sources: Object.fromEntries(fields.map((field) => [field.key, 'Factory built-in'])),
      errors: [],
      basis: view.revision,
    };
  }
  return {
    values: Object.fromEntries(Object.entries(view.settings).map(([key, entry]) => [key, entry.value])),
    sources: Object.fromEntries(Object.entries(view.settings).map(([key, entry]) => [key, entry.source])),
    errors: view.errors.filter((error) => view.fields.some((field) => field.key === error.key) || error.key === 'file'),
    basis: digest(JSON.stringify([view.revision, view.settings])),
  };
}

export function createFolderSettingsSnapshot(project) {
  const root = realpathSync(project);
  const snapshot = {
    root,
    folders: readIssueFolderSettings(root, { includeCopies: true, includeBroken: true }),
    fields: folderSettingsFields(root, { branchChoices: false }),
  };
  const views = new Map();
  const settings = new Map();
  snapshot.read = (directory) => {
    const requested = resolve(root, directory);
    const key = stat(requested)?.isDirectory() ? realpathSync(requested) : requested;
    if (!views.has(key)) views.set(key, readFolderSettings(root, key, { snapshot }));
    return structuredClone(views.get(key));
  };
  return {
    folders: structuredClone(snapshot.folders),
    read: snapshot.read,
    resolve(projectRoot, name) {
      requireThat(realpathSync(projectRoot) === root, 'The folder snapshot belongs to another project.');
      const key = name || null;
      if (!settings.has(key)) settings.set(key, resolveFolderSettings(root, name, { snapshot }));
      return { ...structuredClone(settings.get(key)), fields: structuredClone(snapshot.fields) };
    },
    defaultFolder: () => structuredClone(defaultIssueFolder(root, snapshot)),
  };
}
