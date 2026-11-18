import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createIssueFolderSettings,
  defaultIssueFolder,
  giveIssueFolderCopyNewId,
  initializeFolderSettings,
  previewFolderRepair,
  readFolderSettings,
  readIssueFolderSettings,
  repairFolderSettings,
  resolveFolderSettings,
  updateFolderSettings,
  validateSettingValue,
} from './factory-ui/issue-folder-settings.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-folder-settings-'));
  mkdirSync(join(root, '.issues'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function save(root, directory, changes, extra = {}) {
  const { revision } = readFolderSettings(root, directory);
  return updateFolderSettings(root, { directory, revision, changes, ...extra });
}

test('folder settings migration preserves explicit project defaults and issue overrides once', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({ factoryModel: 'gpt-6.1-sol', factoryEffort: 'low' })
  );
  const local = { defaults: { model: 'gpt-6-astra', effort: 'high' }, issues: { special: { model: 'gpt-6.1-terra' } } };
  writeFileSync(join(root, '.issues/model-settings.json'), JSON.stringify(local));
  writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify({ target: 'release' }));
  const initialized = initializeFolderSettings(root);
  assert.equal(initialized.kind, 'project');
  assert.equal(initialized.settings.branch.value, 'release');
  assert.equal(initialized.settings.model.value, 'gpt-6-astra');
  assert.equal(initialized.settings.effort.value, 'high');
  assert.equal(defaultIssueFolder(root).name, 'Inbox');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.issues/model-settings.json'), 'utf8')), local);
  const rootBytes = readFileSync(join(root, 'folder.md'), 'utf8');
  assert.throws(() => save(root, join(root, 'user/Inbox'), {}, { makeDefault: false }), /replacement/);
  assert.equal(readFileSync(join(root, 'folder.md'), 'utf8'), rootBytes);
});

test('folder settings resolve each field through filesystem parents and project fallbacks', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const parent = createIssueFolderSettings(root, 'Release');
  const child = createIssueFolderSettings(root, 'Release/Plain/Child');
  save(root, parent.directory, { branch: 'release', effort: 'high' });
  save(root, child.directory, { model: 'gpt-6.1-sol' });
  let resolved = resolveFolderSettings(root, child.name);
  assert.equal(resolved.values.branch, 'release');
  assert.equal(resolved.values.model, 'gpt-6.1-sol');
  assert.equal(resolved.values.effort, 'high');
  assert.equal(resolved.sources.branch, 'user/Release/folder.md');
  assert.equal(resolved.sources.skill, 'folder.md');
  assert.equal(resolved.errors.length, 0);
  const before = resolved.basis;
  save(root, parent.directory, { branch: 'next-release' });
  resolved = resolveFolderSettings(root, child.name);
  assert.equal(resolved.values.branch, 'next-release');
  assert.notEqual(resolved.basis, before);
  save(root, root, { branch: 'default' });
  assert.equal(resolveFolderSettings(root, null).values.branch, 'dev');
  assert.equal(resolveFolderSettings(root, null).sources.branch, 'Factory built-in');
});

test('folder repair derives all missing fields from reference and preserves custom keys comments body and id', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Notes');
  const source = `---\n# Important folder comment\nid: ${folder.id} # stable identity\nunknown_setting: keep-me\nbranch: default\n---\n# Notes\nDo not remove this body.\n`;
  writeFileSync(join(folder.directory, 'folder.md'), source);
  const before = readFolderSettings(root, folder.directory);
  const preview = previewFolderRepair(root, folder.directory);
  assert.deepEqual(
    Object.keys(preview.changes),
    before.fields.filter((field) => field.key !== 'branch').map((field) => field.key)
  );
  const repaired = repairFolderSettings(root, { directory: folder.directory, ...preview });
  assert.equal(repaired.missing.length, 0);
  assert.equal(repaired.folder.id, folder.id);
  const after = readFileSync(join(folder.directory, 'folder.md'), 'utf8');
  assert.match(after, /# Important folder comment/);
  assert.match(after, /# stable identity/);
  assert.match(after, /unknown_setting: keep-me/);
  assert.ok(after.endsWith('# Notes\nDo not remove this body.\n'));
  assert.ok(!after.includes('is_default_folder:'));
});

test('broken explicit values remain visible and require an approved repair', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Broken');
  const path = join(folder.directory, 'folder.md');
  writeFileSync(path, `---\nid: ${folder.id}\nmodel: nonexistent-model\nbranch: default\ncustom: retain\n---\n`);
  const before = readFileSync(path, 'utf8');
  const view = readFolderSettings(root, folder.directory);
  assert.equal(view.kind, 'broken');
  assert.ok(view.errors.some((error) => error.key === 'model'));
  assert.ok(readIssueFolderSettings(root).some((entry) => entry.id === folder.id));
  assert.ok(resolveFolderSettings(root, folder.name).errors.some((error) => error.key === 'model'));
  const preview = previewFolderRepair(root, folder.directory);
  assert.equal(preview.changes.model, 'default');
  assert.equal(readFileSync(path, 'utf8'), before);
  repairFolderSettings(root, { directory: folder.directory, ...preview });
  assert.match(readFileSync(path, 'utf8'), /custom: retain/);
  assert.equal(readFolderSettings(root, folder.directory).kind, 'configured');
});

test('unsafe syntax repair retains all original bytes and recoverable membership', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Syntax');
  const source = `---\nid: ${folder.id}\nbranch: [unfinished\ncustom: preserve\n---\nNotes\n`;
  writeFileSync(join(folder.directory, 'folder.md'), source);
  const view = readFolderSettings(root, folder.directory);
  assert.equal(view.kind, 'broken');
  assert.equal(view.folder.id, folder.id);
  assert.equal(view.repairable, false);
  assert.throws(
    () =>
      repairFolderSettings(root, {
        directory: folder.directory,
        revision: view.revision,
        changes: { branch: 'default' },
      }),
    /syntax/
  );
  assert.equal(readFileSync(join(folder.directory, 'folder.md'), 'utf8'), source);
});

test('default folder changes are exclusive and manual conflicts stay explicit', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Chosen');
  save(root, folder.directory, {}, { makeDefault: true });
  assert.equal(defaultIssueFolder(root).id, folder.id);
  assert.equal(readFolderSettings(root, join(root, 'user/Inbox')).isDefaultFolder, false);
  assert.throws(() => save(root, folder.directory, {}, { makeDefault: false }), /replacement/);
  const path = join(root, 'user/Inbox/folder.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('is_default_folder: false', 'is_default_folder: true'));
  assert.throws(() => defaultIssueFolder(root), /exactly one/);
  assert.ok(readFolderSettings(root, folder.directory).errors.some((error) => error.key === 'is_default_folder'));
  save(root, folder.directory, {}, { makeDefault: true });
  assert.equal(defaultIssueFolder(root).id, folder.id);
  writeFileSync(
    join(folder.directory, 'folder.md'),
    readFileSync(join(folder.directory, 'folder.md'), 'utf8').replace(
      'is_default_folder: true',
      'is_default_folder: false'
    )
  );
  assert.throws(() => defaultIssueFolder(root), /exactly one/);
  initializeFolderSettings(root);
  assert.throws(() => defaultIssueFolder(root), /exactly one/);
});

test('pinned project folders use collision-free names and authoritative directories', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const legacy = createIssueFolderSettings(root, 'docs/Tasks');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, '.issues/sidebar-files.local.json'),
    JSON.stringify([{ id: 'docs', base: join(root, 'docs') }])
  );
  const project = createIssueFolderSettings(root, '/docs/Tasks');
  assert.equal(legacy.name, 'docs/Tasks');
  assert.equal(project.name, '/docs/Tasks');
  assert.equal(project.projectPath, 'docs/Tasks');
  assert.equal(project.directory, realpathSync(join(root, 'docs/Tasks')));
  assert.ok(readIssueFolderSettings(root).some((entry) => entry.id === legacy.id));
  assert.ok(readIssueFolderSettings(root).some((entry) => entry.id === project.id));
  assert.ok(!readIssueFolderSettings(root).some((entry) => entry.directory === root));
  const outside = mkdtempSync(join(tmpdir(), 'timey-outside-folder-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'folder.md'), `---\nid: ${randomUUID()}\n---\n`);
  assert.equal(readFolderSettings(root, outside).canConfigure, false);
  assert.equal(readFolderSettings(root, outside).kind, 'plain');
});

test('settings reject stale writes symlinks and identity replacement', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Safe');
  const view = readFolderSettings(root, folder.directory);
  save(root, folder.directory, { effort: 'high' });
  assert.throws(
    () =>
      updateFolderSettings(root, { directory: folder.directory, revision: view.revision, changes: { effort: 'low' } }),
    /changed/
  );
  assert.throws(() => save(root, folder.directory, { id: randomUUID() }), /supported inherited/);
  symlinkSync(folder.directory, join(root, 'user/Link'));
  assert.throws(() => readFolderSettings(root, join(root, 'user/Link')), /symlink/);
  assert.throws(() => createIssueFolderSettings(root, 'Link/Child'), /symlink/);
  assert.equal(existsSync(join(folder.directory, 'Child')), false);
});

test('duplicate identities are preserved until explicitly repaired', (t) => {
  const root = fixture(t);
  initializeFolderSettings(root);
  const folder = createIssueFolderSettings(root, 'Original');
  mkdirSync(join(root, 'user/Copy'));
  const source = readFileSync(join(folder.directory, 'folder.md'), 'utf8');
  writeFileSync(join(root, 'user/Copy/folder.md'), source);
  assert.ok(!readIssueFolderSettings(root).some((entry) => entry.id === folder.id));
  assert.equal(
    readIssueFolderSettings(root, { includeCopies: true }).filter((entry) => entry.id === folder.id).length,
    2
  );
  assert.equal(readFolderSettings(root, join(root, 'user/Copy')).kind, 'broken');
  const newIdentity = giveIssueFolderCopyNewId(root, 'Copy');
  assert.notEqual(newIdentity.id, folder.id);
  assert.equal(
    readIssueFolderSettings(root).filter((entry) => [newIdentity.id, folder.id].includes(entry.id)).length,
    2
  );
});

test('per-issue and folder validation share the reference choices', () => {
  assert.equal(validateSettingValue(process.cwd(), 'branch', 'release/next'), null);
  assert.ok(validateSettingValue(process.cwd(), 'branch', 'bad branch'));
  assert.equal(validateSettingValue(process.cwd(), 'effort', 'default'), null);
  assert.equal(validateSettingValue(process.cwd(), 'effort', 'high'), null);
  assert.ok(validateSettingValue(process.cwd(), 'effort', 'guess'));
  assert.ok(validateSettingValue(process.cwd(), 'unlisted', 'high'));
});
