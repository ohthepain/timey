import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { newFlow } from './factory-ui/flow-store.mjs';
import {
  createIssueFolderSettings,
  readFolderSettings,
  updateFolderSettings,
} from './factory-ui/issue-folder-settings.mjs';

function fixture(t) {
  const { root, git } = gitFixture(t, 'flow-view-settings-');
  mkdirSync(join(root, '.issues'));
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
  createIssueFolderSettings(root, 'Release');
  const issues = [0, 1, 2].map((number) => ({ id: '20261122-settings-' + number, title: 'Feature', content: '' }));
  for (const issue of issues) {
    writeFileSync(
      join(root, '.issues', issue.id + '.md'),
      `---\nid: ${issue.id}\ntitle: Feature\nstate: backlog\n---\n`
    );
    const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
    flow.folder = 'Release';
    flows.store.save(flow, flow.revision);
  }
  const settings = (changes) => {
    const directory = join(root, 'user/Release');
    const view = readFolderSettings(root, directory);
    updateFolderSettings(root, { directory, revision: view.revision, changes });
  };
  return { root, flows, issues, settings };
}

test('each Flow view reads current folder settings without leaking issue overrides into siblings', async (t) => {
  const { flows, issues, settings } = fixture(t);
  const overridden = flows.read(issues[0]);
  overridden.settings = { model: 'gpt-6-astra' };
  flows.store.save(overridden, overridden.revision);
  settings({ branch: 'release', model: 'gpt-6.1-terra' });
  let view = await flows.view(issues[1].id);
  assert.equal(view.issueSettings.values.model, 'gpt-6.1-terra');
  assert.equal(view.flow.resolvedBranch, 'release');
  assert.ok(view.issues.every((issue) => issue.resolvedBranch === 'release'));
  assert.equal((await flows.view(issues[0].id)).issueSettings.values.model, 'gpt-6-astra');
  settings({ branch: 'dev', model: 'gpt-6-astra' });
  view = await flows.view(issues[1].id);
  assert.equal(view.issueSettings.values.model, 'gpt-6-astra');
  assert.equal(view.flow.resolvedBranch, 'dev');
  assert.ok(view.issues.every((issue) => issue.resolvedBranch === 'dev'));
});

test('folder edits during observation affect the next view while started work retains frozen settings', async (t) => {
  const { flows, issues, settings } = fixture(t);
  settings({ branch: 'release', model: 'gpt-6.1-terra' });
  const frozen = flows.read(issues[0]);
  frozen.executionSettings = flows.issueSettings(issues[0], frozen);
  flows.store.save(frozen, frozen.revision);
  let observed;
  const observing = new Promise((resolve) => {
    observed = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  flows.observer = {
    observe: async () => {
      observed();
      await hold;
      return {};
    },
  };
  const pending = flows.view(issues[1].id);
  await observing;
  settings({ branch: 'dev', model: 'gpt-6-astra' });
  release();
  const current = await pending;
  assert.equal(current.issueSettings.values.model, 'gpt-6.1-terra');
  assert.equal(current.flow.resolvedBranch, 'release');
  flows.observer = { observe: async () => ({}) };
  const next = await flows.view(issues[1].id);
  assert.equal(next.issueSettings.values.model, 'gpt-6-astra');
  assert.equal(next.flow.resolvedBranch, 'dev');
  const retained = await flows.view(issues[0].id);
  assert.equal(retained.issueSettings.values.model, 'gpt-6.1-terra');
  assert.equal(retained.flow.resolvedBranch, 'release');
  assert.equal(retained.issueSettings.frozen, true);
  assert.equal(flows.issueSettings(issues[2], flows.read(issues[2])).values.model, 'gpt-6-astra');
});
