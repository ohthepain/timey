import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { newFlow } from './factory-ui/flow-store.mjs';
import {
  createIssueFolderSettings,
  createFolderSettingsSnapshot,
  resolveFolderSettings,
  readFolderSettings,
  updateFolderSettings,
} from './factory-ui/issue-folder-settings.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'folder-view-snapshot-');
  fs.mkdirSync(join(root, '.issues'));
  git('commit', '--allow-empty', '-qm', 'fixture');
  git('branch', 'dev');
  git('branch', 'release');
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const flows = createIssueFlows(service, { observer: { observe: async () => ({}) } });
  t.after(() => flows.close());
  const folders = ['Alpha', 'Beta', 'Gamma'];
  for (const name of folders) createIssueFolderSettings(root, name);
  const issues = folders.map((folder, index) => {
    const issue = { id: '20261123-folder-' + index, title: 'Feature', content: '' };
    fs.writeFileSync(
      join(root, '.issues', issue.id + '.md'),
      `---\nid: ${issue.id}\ntitle: Feature\nstate: backlog\n---\n`
    );
    const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
    flow.folder = folder;
    flows.store.save(flow, flow.revision);
    return issue;
  });
  return { root, flows, issues };
}

test('one Flow view discovers the folder tree once for issue settings and folder forms', async (t) => {
  const { root, flows, issues } = fixture(t);
  const original = fs.readdirSync;
  let scans = 0;
  const user = fs.realpathSync(join(root, 'user'));
  fs.readdirSync = (path, ...args) => {
    if (String(path) === user) scans++;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  });
  const view = await flows.view(issues[0].id);
  assert.equal(view.folderSettings.length, 4);
  assert.equal(view.issues.length, 3);
  assert.equal(scans, 1, 'Folder discovery must be shared across one rendered view.');
});

test('a new Flow view sees external folder edits while mutation reads stay fresh', async (t) => {
  const { root, flows, issues } = fixture(t);
  const first = await flows.view(issues[0].id);
  assert.equal(first.flow.resolvedBranch, 'dev');
  const directory = join(root, 'user/Alpha');
  const settings = readFolderSettings(root, directory);
  updateFolderSettings(root, { directory, revision: settings.revision, changes: { branch: 'release' } });
  const next = await flows.view(issues[0].id);
  assert.equal(next.flow.resolvedBranch, 'release');
  assert.equal(next.folderSettings.find(({ name }) => name === 'Alpha').values.branch, 'release');
  await assert.rejects(
    async () => updateFolderSettings(root, { directory, revision: settings.revision, changes: { branch: 'dev' } }),
    /changed/
  );
});

test('folder snapshots retain duplicate diagnostics and isolate returned values and projects', (t) => {
  const { root } = fixture(t);
  const directory = join(root, 'user/Alpha');
  fs.cpSync(directory, join(root, 'user/Copy'), { recursive: true });
  const snapshot = createFolderSettingsSnapshot(root);
  assert.throws(() => snapshot.resolve(root, 'Alpha'), /existing issue folder/);
  assert.throws(() => resolveFolderSettings(root, 'Alpha'), /existing issue folder/);
  const direct = readFolderSettings(root, directory, { branchChoices: false });
  const saved = snapshot.read(directory);
  assert.deepEqual(saved.errors, direct.errors);
  assert.ok(saved.errors.some(({ message }) => message.includes('shares its ID')));
  saved.settings.branch.value = 'Poisoned';
  assert.notEqual(snapshot.read(directory).settings.branch.value, 'Poisoned');
  const other = gitFixture(t, 'folder-snapshot-other-');
  assert.throws(() => snapshot.resolve(other.root, null), /another project/);
});

test('one view reuses observed choices when validating explicit issue overrides', async (t) => {
  const { root, flows, issues } = fixture(t);
  const skills = join(root, 'user/skills');
  fs.mkdirSync(join(skills, 'first'), { recursive: true });
  fs.writeFileSync(join(skills, 'first/SKILL.md'), '# First\n');
  for (const issue of issues) {
    const flow = flows.store.read(issue);
    flow.settings = { branch: 'release', skill: 'first', effort: 'high' };
    flows.store.save(flow, flow.revision);
  }
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (path, ...args) => {
    if (fs.realpathSync(path) === fs.realpathSync(skills)) scans++;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  });
  const first = await flows.view(issues[0].id);
  assert.equal(scans, 3, 'Folder discovery and the two view field lists cover all issue overrides.');
  assert.equal(first.issueSettings.values.skill, 'first');
  fs.mkdirSync(join(skills, 'second'));
  fs.writeFileSync(join(skills, 'second/SKILL.md'), '# Second\n');
  const flow = flows.store.read(issues[0]);
  flow.settings.skill = 'second';
  flows.store.save(flow, flow.revision);
  const next = await flows.view(issues[0].id);
  assert.equal(next.issueSettings.values.skill, 'second');
  assert.equal(
    next.issueSettings.errors.some(({ key }) => key === 'skill'),
    false
  );
  assert.ok(
    readFolderSettings(root, join(root, 'user/Alpha'))
      .fields.find(({ key }) => key === 'skill')
      .choices.some(({ value }) => value === 'second')
  );
});
