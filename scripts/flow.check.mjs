import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFixture } from './git-fixture.mjs';
import {
  blockDetails,
  definitionMap,
  deliveryTarget,
  latestCurrentAttempt,
  requestData,
  startingPoint,
} from './factory-ui/flow-block-data.mjs';
import { giveIssueFolderCopyNewId, initializeFolderSettings } from './factory-ui/issue-folder-settings.mjs';
import { FlowStore, newFlow, editFlow, makeBlock } from './factory-ui/flow-store.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createFlowObserver } from './factory-ui/flow-observer.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { humanGuard } from './factory-ui/guard.mjs';
import { ViewSources } from './factory-ui/view-sources.mjs';
import { BlockCatalog, blockExtensions, userBlocks } from './factory-ui/block-catalog.mjs';
import { moveIssueStorage } from './factory-ui/issue-storage-actions.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { issueCleanupIdentities, previewIssueCleanupResource } from './factory-ui/issue-cleanup.mjs';
import { saveConversationState } from './factory-ui/conversation-store.mjs';
import { runRetro } from './factory-ui/flow-retro.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

test('Markdown block defaults apply to new blocks and user definitions keep the Work operation', (t) => {
  const { root } = gitFixture(t, 'block-catalog-');
  const catalog = new BlockCatalog(root);
  const issue = { id: 'test', title: 'Feature', content: '' };
  const saved = newFlow(issue, 'dev', catalog.read().entries);
  const beforeExtension = catalog.read().entries.find(({ id }) => id === 'work');
  const extensionFile = catalog.openExtension('work');
  assert.equal(catalog.openExtension('work'), extensionFile);
  assert.equal(catalog.read().entries.find(({ id }) => id === 'work').checksum, beforeExtension.checksum);
  writeFileSync(extensionFile, '# System prompt\n\nUse the project review steps.\n');
  assert.equal(
    catalog.read().entries.find(({ id }) => id === 'work').prompt,
    beforeExtension.prompt + '\n\nUse the project review steps.'
  );
  rmSync(extensionFile);
  assert.equal(saved.blocks.find((block) => block.kind === 'work').skill, 'poteto-mode');
  assert.deepEqual(catalog.read().entries.find((entry) => entry.id === 'work').skills, [
    'poteto-mode',
    'arena',
    'swarm',
  ]);
  const folder = join(root, userBlocks);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'catalog.json'),
    JSON.stringify({ work: { defaultSkill: 'arena' }, 'project-review': { label: 'Project review' } })
  );
  const custom = join(folder, 'project-review.md');
  writeFileSync(custom, '# Project review\n\nReview this change.\n');
  const result = catalog.read();
  assert.deepEqual(result.errors, []);
  const created = newFlow(issue, 'dev', result.entries);
  assert.equal(created.blocks.find((block) => block.kind === 'work').skill, 'arena');
  assert.equal(saved.blocks.find((block) => block.kind === 'work').skill, 'poteto-mode');
  const changed = editFlow(saved, { action: 'add', kind: 'project-review' }, result.entries);
  const block = changed.blocks.find((item) => item.definition === 'project-review');
  assert.equal(block.kind, 'work');
  assert.equal(block.skill, null);
  const workPath = join(folder, 'work.md');
  writeFileSync(workPath, '# Skill list\n\n- `arena`\n- how\n');
  const extensionFolder = join(root, blockExtensions);
  mkdirSync(extensionFolder, { recursive: true });
  const legacyExtension = join(folder, 'work_user.md');
  writeFileSync(legacyExtension, 'Legacy note.\n');
  const extension = join(extensionFolder, 'work.md');
  writeFileSync(extension, '## Project notes\n\n- Keep the command output.\n');
  const extended = catalog.read();
  assert.deepEqual(extended.errors, []);
  const work = extended.entries.find((entry) => entry.id === 'work');
  assert.deepEqual(work.skills, ['arena', 'how']);
  assert.match(work.content.html, /Complete only this block/);
  assert.match(work.content.html, /<li>Keep the command output\.<\/li>/);
  assert.doesNotMatch(work.content.html, /Legacy note/);
  assert.equal(work.content.extension, extension);
  assert.equal(work.content.extensionPath, 'user/flow/extensions/blocks/work.md');
  const workOverride = readFileSync(workPath, 'utf8');
  const checksumForDeclaration = (declaration) => {
    writeFileSync(workPath, workOverride + '\n# User extensions\n\n`' + declaration + '`\n');
    return catalog.read().entries.find((entry) => entry.id === 'work').checksum;
  };
  assert.equal(checksumForDeclaration('user/flow/extensions/blocks/work.md'), checksumForDeclaration('work.md'));
  assert.doesNotMatch(work.content.html, /Skill list/);
  assert.equal(
    extended.entries.some((entry) => entry.id === 'work_user'),
    false
  );
  writeFileSync(workPath, '# Skill list\n\n- arena\n- arena\n');
  const badList = catalog.read();
  assert.match(badList.errors[0], /unique skill name/);
  assert.deepEqual(badList.entries.find((entry) => entry.id === 'work').skills, ['arena', 'how']);
  rmSync(workPath);
  rmSync(extension);
  assert.match(catalog.read().entries.find((entry) => entry.id === 'work').content.html, /Legacy note/);
  rmSync(legacyExtension);
  assert.deepEqual(catalog.read().entries.find((entry) => entry.id === 'work').skills, [
    'poteto-mode',
    'arena',
    'swarm',
  ]);
  writeFileSync(custom, '---\nkind: merge\n---\n');
  const invalid = catalog.read();
  assert.match(invalid.errors[0], /contains front matter/);
  assert.equal(invalid.entries.find((item) => item.id === 'project-review').kind, 'work');
  rmSync(custom);
  assert.equal(
    catalog.read().entries.some((item) => item.id === 'project-review'),
    false
  );
  assert.equal(block.skill, null);
});

test('UI source updates match a clean build and preserve the last valid override', (t) => {
  const { root } = gitFixture(t, 'view-sources-');
  const sources = new ViewSources(root);
  const initial = sources.update();
  const [details, conversation] = initial.entries;
  assert.equal(details.label, 'Details');
  assert.deepEqual(sources.update().changed, []);
  const firstEdit = sources.edit(details.id, details.editRevision, 'Notes');
  assert.deepEqual(firstEdit.changed, [details.view]);
  assert.deepEqual(firstEdit.entries, new ViewSources(root).update().entries);
  const path = join(root, details.overridePath);
  assert.throws(() => sources.edit(conversation.id, conversation.editRevision, 'Stale'), /changed on disk/);
  const edit = firstEdit.entries[1];
  const updated = sources.edit(edit.id, edit.editRevision, 'Discussion');
  assert.match(readFileSync(path, 'utf8'), /## details-tab\n\nNotes\n\n## conversation-tab\n\nDiscussion/);
  assert.deepEqual(updated.entries, new ViewSources(root).update().entries);
  writeFileSync(path, '## obsolete-tab\n\nTyped label\n');
  const rejected = sources.update();
  assert.deepEqual(rejected.changed, []);
  assert.match(rejected.errors[0], /unknown section: obsolete-tab/);
  assert.equal(rejected.entries[0].label, 'Notes');
  assert.equal(new ViewSources(root).update().entries[0].label, 'Details');
  rmSync(path);
  assert.deepEqual(sources.update().entries, initial.entries);
});

function fixture(t) {
  const { root, git } = gitFixture(t, 'explicit-flow-');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, 'source.txt'), 'original');
  initializeFolderSettings(root);
  git('add', '.');
  git('commit', '-qm', 'original');
  git('branch', 'dev');
  const id = '20261113-one';
  writeFileSync(
    join(root, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: Preserve request wording\nstate: backlog\ncreated: 2026-11-13T12:00:00Z\n---\n\n## Original request\n\nFix the broken save button.\nDone: Saved value persists after reload.\nProof: Stored value.\nConstraints: Repro first.\n`
  );
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  return { root, git, id, service };
}
function executor(run) {
  return { run, close() {} };
}

test('Understand receives its declared issue title and report instead of empty manual inputs', (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  const issue = flows.selected(id);
  const catalog = new BlockCatalog(root).read().entries;
  const flow = flows.read(issue, catalog);
  const block = makeBlock('understand', ['request'], false, catalog);
  flow.blocks.push(block);
  const details = blockDetails(flow, issue, block, definitionMap(catalog));
  for (const [key, value] of [
    ['title', issue.title],
    ['report', issue.content],
  ]) {
    const detail = details.find((entry) => entry.key === key);
    assert.equal(detail.value, value);
    assert.equal(detail.fixed, true);
  }
});

test('Retro follow-ups retain their source issue so an investigation can read original attempt evidence', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  await flows.fileRetroItems(
    [
      {
        requestId: randomUUID(),
        title: 'Investigate publication failure',
        description: 'Review the failed publication attempts.',
        reason: 'GitHub rejected publication.',
        verification: 'Retain the original attempt evidence.',
      },
    ],
    id
  );
  const followup = flows.issues().find((issue) => issue.title === 'Investigate publication failure');
  assert.equal(followup.source_issue, id);
  assert.match(followup.content, new RegExp(id));
});

test('repeated report reads retain current metadata, bodies, numbers and storage locations', (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  const path = join(root, '.issues', id + '.md');
  const original = readFileSync(path, 'utf8').replace('state: backlog', 'state: backlog\nreview:\n  approved: false');
  writeFileSync(path, original);
  const saved = statSync(path);
  const first = flows.selected(id);
  first.review.approved = true;
  assert.equal(flows.selected(id).review.approved, false);
  const changed = original.replace('Preserve request wording', 'Modified request wording');
  assert.equal(changed.length, original.length);
  writeFileSync(path, changed);
  utimesSync(path, saved.atime, saved.mtime);
  assert.equal(flows.selected(id).title, 'Modified request wording');
  writeFileSync(path, changed.replace('Stored value.', 'Newest value.'));
  assert.match(flows.selected(id).content, /Newest value\./);
  writeFileSync(join(root, '.issues/issue-numbers.json'), JSON.stringify({ issues: { [id]: 27 } }));
  assert.equal(flows.selected(id).issueNumber, 27);
  mkdirSync(join(root, '.issues/closed'));
  const closed = join(root, '.issues/closed', id + '.md');
  renameSync(path, closed);
  assert.equal(flows.issues()[0].location, 'closed');
  mkdirSync(join(root, '.issues/archive'));
  renameSync(closed, join(root, '.issues/archive', id + '.md'));
  assert.deepEqual(flows.issues(), []);
  assert.equal(flows.selected(id).location, 'archive');
  rmSync(join(root, '.issues/archive', id + '.md'));
  assert.throws(() => flows.selected(id), /no longer exists/);
});

test('flow views show saved reports while shared queue refresh is pending and observe later updates', async (t) => {
  const { root, id, service } = fixture(t);
  const refresh = Promise.withResolvers();
  let warning = 'The last observed queue is shown.';
  service.sharedIssues = {
    refreshInBackground(wait) {
      return wait ? refresh.promise : warning;
    },
    view() {},
  };
  const flows = createIssueFlows(service, { observer: { observe: async () => ({}) } });
  t.after(() => flows.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const first = await Promise.race([
    flows.view(id),
    delay(1000, null, { signal: controller.signal }).then(() => assert.fail('Saved view waited for the network')),
  ]);
  assert.equal(first.issue.title, 'Preserve request wording');
  assert.equal(first.sharedQueueWarning, warning);
  const path = join(root, '.issues', id + '.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Preserve request wording', 'Updated by remote refresh'));
  warning = null;
  refresh.resolve();
  const second = await flows.view(id);
  assert.equal(second.issue.title, 'Updated by remote refresh');
  assert.equal(second.sharedQueueWarning, null);
});

test('flow views wait for the first shared copy of a selected report', async (t) => {
  const { root, id, service } = fixture(t);
  const path = join(root, '.issues', id + '.md');
  const content = readFileSync(path, 'utf8');
  rmSync(path);
  const refresh = Promise.withResolvers();
  const requested = Promise.withResolvers();
  service.sharedIssues = {
    refreshInBackground() {
      requested.resolve();
      return refresh.promise;
    },
    view() {},
  };
  const flows = createIssueFlows(service, { observer: { observe: async () => ({}) } });
  t.after(() => flows.close());
  const view = flows.view(id);
  await requested.promise;
  writeFileSync(path, content);
  refresh.resolve(null);
  const result = await view;
  assert.equal(result.issue.title, 'Preserve request wording');
  assert.equal(result.issues.find((issue) => issue.id === id)?.title, 'Preserve request wording');
  assert.equal(result.sharedQueueWarning, null);
});

test('issue route Start runs Update Branch without confirmation and Pause lets the active block finish', async (t) => {
  const { id, service } = fixture(t);
  const started = [];
  const work = Promise.withResolvers();
  const flows = createIssueFlows(service, {
    clarify: async () => ({ artifacts: { values: { type: 'bug', goal: 'Repair Save' } } }),
    executor: executor(async ({ block, signal, input }) => {
      started.push(block.kind);
      if (block.kind === 'work') await work.promise;
      if (block.kind === 'publish') assert.equal(input.automaticPublication, true);
      assert.equal(signal.aborted, false);
      return { summary: 'Done' };
    }),
  });
  t.after(() => flows.close());
  const action = (name, fields) =>
    flows.action({ issueId: id, revision: flows.read(flows.selected(id)).revision, action: name, ...fields });
  const pending = (kind) => flows.read(flows.selected(id)).blocks.find((block) => block.kind === kind);
  const view = () => flows.view(id);
  assert.deepEqual((await view()).autoplay, { mode: 'paused' });
  assert.deepEqual(started, []);
  await action('add', { kind: 'verify', afterId: pending('work').id });
  await action('add', { kind: 'update-branch', afterId: pending('verify').id });
  await action('play');
  assert.deepEqual(started, ['work']);
  assert.equal(pending('request').attempts.at(-1).status, 'completed');
  await action('pause');
  const running = flows.active.get(id).task;
  work.resolve();
  await running;
  assert.deepEqual(started, ['work']);
  await action('play');
  while (flows.active.get(id)?.task) await flows.active.get(id).task;
  assert.deepEqual(started, ['work', 'verify', 'update-branch', 'publish', 'merge']);
  assert.deepEqual((await view()).autoplay, { mode: 'paused', reason: 'Close the issue when ready.' });
  for (const kind of ['publish', 'merge', 'close']) await action('remove', { blockId: pending(kind).id });
  assert.equal((await view()).autoplay.mode, 'paused');
  await action('play');
  assert.deepEqual((await view()).autoplay, { mode: 'paused', reason: 'Flow complete' });
});

async function waitForNightSignal(signal, label) {
  let timer;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Work All Night did not ${label} within 30 seconds.`)), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('Work All Night keeps dependency failures separate and retains the exact handoff', async (t) => {
  const { id, root, service } = fixture(t);
  const dependent = '20261113-dependent';
  const child = '20261113-dependent-child';
  const independent = '20261113-independent';
  for (const next of [dependent, child, independent]) {
    const dependency = next === child ? `\n## Blocked by\n\n- ${id}\n` : '';
    const grouping = next === dependent ? `issue_group:\n  children:\n    - id: ${child}\n` : '';
    writeFileSync(
      join(root, '.issues', next + '.md'),
      `---\nid: ${next}\ntitle: Repair ${next}\nstate: backlog\ncreated: 2026-11-13T12:00:00Z\n${grouping}---\n\n## Original request\n\nFix an issue.\n${dependency}`
    );
  }
  const started = [];
  const flows = createIssueFlows(service, {
    clarify: async () => ({ artifacts: { values: { type: 'bug', goal: 'Repair Save' } } }),
    executor: executor(async ({ issue, block, input }) => {
      started.push([issue.id, block.kind]);
      if (issue.id === id) return { status: 'blocked', summary: 'Save regression check failed.' };
      if (block.kind === 'publish') assert.equal(input.automaticPublication, true);
      if (block.kind === 'merge') {
        assert.equal(input.prepareMerge, true);
        return {
          status: 'blocked',
          summary: 'PR checks passed.',
          result: { mergeConfirmation: { pr: 5 }, verification: { head: 'verified' } },
        };
      }
      return { summary: 'Done' };
    }),
  });
  t.after(() => flows.close());
  const folder = 'Save repairs';
  await flows.action({ action: 'create-folder', name: folder });
  const issueIds = [id, dependent, independent];
  for (const issueId of issueIds) {
    const flow = flows.read(flows.selected(issueId));
    flow.folder = folder;
    flows.store.save(flow, flow.revision);
  }
  const plan = await flows.action({ action: 'folder-night-plan', folder, issueIds });
  assert.deepEqual(
    plan.issues.map((issue) => issue.id),
    issueIds
  );
  await flows.action({ action: 'folder-night-start', planId: plan.id });
  let report;
  for (let retries = 0; retries < 100; retries += 1) {
    report = flows.overnight.reports()[folder];
    if (report.status === 'finished') break;
    await delay(20);
  }
  assert.equal(report.status, 'finished');
  assert.deepEqual(
    report.issues.map(({ status }) => status),
    ['paused', 'paused', 'ready'],
    [JSON.stringify(report), report.issues.map(({ summary }) => summary).join('\n')].join('\n')
  );
  assert.equal(report.issues[0].failedCheck, 'Work');
  assert.match(report.issues[0].summary, /regression check failed/);
  assert.match(report.issues[1].summary, /Blocked by/);
  assert.equal(report.issues[2].pr, 5);
  assert.deepEqual(started, [
    [id, 'work'],
    [independent, 'work'],
    [independent, 'publish'],
    [independent, 'merge'],
  ]);
  const restarted = createIssueFlows(service, { executor: executor(() => assert.fail('Replayed saved work')) });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.overnight.reports()[folder], report);
});

test('stopping Work All Night cancels the owned block and leaves queued issues untouched', async (t) => {
  const { id, root, service } = fixture(t);
  const queued = '20261113-queued';
  writeFileSync(
    join(root, '.issues', queued + '.md'),
    `---\nid: ${queued}\ntitle: Queued issue\nstate: backlog\ncreated: 2026-11-13T12:00:00Z\n---\n\n## Original request\n\nFix an issue.\n`
  );
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const flows = createIssueFlows(service, {
    clarify: async () => ({ artifacts: { values: { type: 'bug', goal: 'Repair Save' } } }),
    executor: executor(async ({ issue, signal }) => {
      assert.equal(issue.id, id);
      started.resolve();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          stopped.resolve();
          resolve({ status: 'stopped', summary: 'Partial work retained.' });
        });
      });
    }),
  });
  t.after(() => flows.close());
  const folder = 'Save repairs';
  await flows.action({ action: 'create-folder', name: folder });
  for (const issueId of [id, queued]) {
    const flow = flows.read(flows.selected(issueId));
    flow.folder = folder;
    flows.store.save(flow, flow.revision);
  }
  const plan = await flows.action({ action: 'folder-night-plan', folder, issueIds: [id, queued] });
  await flows.action({ action: 'folder-night-start', planId: plan.id });
  await waitForNightSignal(started.promise, 'start its worker');
  await flows.action({ action: 'folder-night-stop', folder });
  await waitForNightSignal(stopped.promise, 'stop its worker');
  let report;
  for (let retries = 0; retries < 100; retries += 1) {
    report = flows.overnight.reports()[folder];
    if (report.status === 'stopped') break;
    await delay(20);
  }
  assert.equal(report.status, 'stopped');
  assert.deepEqual(
    report.issues.map(({ status }) => status),
    ['stopped', 'stopped']
  );
  assert.ok(flows.read(flows.selected(queued)).blocks.every((block) => !block.attempts.length));
});

test('issue route Resume pauses on failure and Stop, retries once, and does not recover after restart', async (t) => {
  const { id, service } = fixture(t);
  const started = [];
  const fail = Promise.withResolvers();
  const flows = createIssueFlows(service, {
    executor: executor(async ({ block, signal, continuing }) => {
      started.push([block.kind, continuing]);
      if (started.length === 1) {
        await fail.promise;
        throw Error('Test blocked.');
      }
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(Error('Stopped')), { once: true })
      );
    }),
  });
  t.after(() => flows.close());
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.blocks.find((block) => block.kind === 'request').data.fields = { type: 'bug', goal: 'Repair Save' };
  flows.store.save(flow, flow.revision);
  const blockId = flow.blocks.find((block) => block.kind === 'work').id;
  const action = (name) => flows.action({ issueId: id, revision: flows.read(issue).revision, action: name, blockId });
  await action('start');
  assert.deepEqual((await flows.view(id)).autoplay, { mode: 'paused' });
  const manualRun = flows.active.get(id).task;
  await flows.action({ issueId: id, revision: flow.revision, action: 'play' });
  assert.equal((await flows.view(id)).autoplay.mode, 'playing');
  fail.resolve();
  await manualRun;
  assert.deepEqual((await flows.view(id)).autoplay, { mode: 'paused', reason: 'Test blocked.' });
  assert.equal(started.length, 1);
  await action('play');
  assert.equal((await flows.view(id)).autoplay.mode, 'playing');
  const running = flows.active.get(id).task;
  await action('stop');
  await running;
  assert.deepEqual(started, [
    ['work', false],
    ['work', true],
  ]);
  assert.equal((await flows.view(id)).autoplay.mode, 'paused');
  await action('play');
  const restarted = createIssueFlows(service, { executor: executor(async () => assert.fail('Unexpected restart')) });
  t.after(() => restarted.close());
  assert.deepEqual((await restarted.view(id)).autoplay, { mode: 'paused' });
  await restarted.action({ issueId: id, revision: restarted.read(issue).revision, action: 'play' });
  assert.match((await restarted.view(id)).autoplay.reason, /Recover Work/);
  const lastRun = flows.active.get(id).task;
  await action('stop');
  await lastRun;
});

test('the issue pencil preserves results while changing Your words invalidates verification', async (t) => {
  const { root, id, service } = fixture(t);
  let fields = {
    type: 'bug',
    goal: 'Repair Save',
    requestedProof: 'Save a change and show it persists after reload.',
    constraints: 'Use local data',
  };
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({ summary: 'Verified' })),
    async clarify() {
      return { artifacts: { values: fields } };
    },
  });
  t.after(() => flows.close());
  let view = await flows.view(id);
  const act = async (action, input) => {
    view = await flows.action({ action, issueId: id, revision: view.flow.revision, ...input });
  };
  await act('request', { wording: 'Fix Save' });
  await act('add', { kind: 'verify', afterId: 'work' });
  const verify = view.flow.blocks.find((block) => block.kind === 'verify');
  await flows.action({ action: 'start', issueId: id, revision: view.flow.revision, blockId: verify.id });
  await flows.active.get(id)?.task;
  view = await flows.view(id);
  const currentVerify = () => view.flow.blocks.find((block) => block.kind === 'verify').attempts.at(-1);
  assert.equal(currentVerify().status, 'completed');
  await act('rename-issue', { previousTitle: view.issue.title, title: 'Fix the Save button' });
  assert.equal(view.issue.title, 'Fix the Save button');
  assert.equal(requestData(view.flow).wording, 'Fix Save');
  assert.equal(currentVerify().invalidatedAt, undefined);
  const title = view.flow.blocks
    .find((block) => block.kind === 'publish')
    .details.find((detail) => detail.key === 'title');
  assert.equal(title.value, view.issue.title);
  assert.equal(title.fixed, true);
  assert.equal(title.requestId, 'request');
  fields = { ...fields, constraints: 'Use test data' };
  await act('request', { wording: 'Fix the Save action' });
  assert.equal(view.issue.title, 'Fix the Save button');
  assert.ok(currentVerify().invalidatedAt);
  fields = { ...fields, requestedProof: 'Reload twice' };
  await act('request', { wording: 'Fix the Save action' });
  assert.ok(currentVerify().invalidatedAt);
  const report = readFileSync(join(root, '.issues', id + '.md'), 'utf8');
  assert.match(report, /title: Fix the Save button/);
  assert.match(report, /## Original request\n\nFix the broken save button\./);
});

test('Destination follows the starting branch until pinned, then locks to an existing PR and asks about a GitHub base change', async (t) => {
  const { root, git, id, service } = fixture(t);
  const config = { provider: 'github', repository: 'test/fixture', remote: 'origin', target: 'dev' };
  writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  git('branch', 'recent');
  git('update-ref', 'refs/remotes/upstream/recent', 'HEAD');
  let pr;
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({ summary: 'done' })),
    deliveryOptions: {
      provider: {
        config,
        async gh() {
          return 'dev\nrecent\nrelease';
        },
        async findIssueBranchPR() {
          return pr;
        },
        async inspect() {
          return pr;
        },
      },
    },
    observer: {
      async observe() {
        return pr ? { pr: { number: pr.number, url: pr.html_url, branch: pr.base.ref } } : {};
      },
    },
  });
  t.after(() => flows.close());
  let view = await flows.view(id);
  const act = async (action, input) => {
    view = await flows.action({ action, issueId: id, revision: view.flow.revision, ...input });
  };
  await act('starting-point', { ref: 'refs/heads/recent' });
  assert.equal(view.destination.branch, 'recent');
  assert.equal(view.destination.follows, true);
  await act('destination', { branch: 'release' });
  assert.equal(view.destination.branch, 'release');
  await act('starting-point', { ref: 'refs/remotes/upstream/recent' });
  assert.equal(view.destination.branch, 'release');
  await act('destination', { branch: null });
  assert.equal(view.destination.branch, null);
  const saved = flows.read(flows.selected(id));
  saved.workspace = { checkout: root, branch: 'codex/fixture' };
  flows.store.save(saved, saved.revision);
  pr = {
    number: 9,
    html_url: 'https://example.invalid/pr/9',
    head: { ref: saved.workspace.branch, repo: { full_name: config.repository } },
    base: { ref: 'dev', repo: { full_name: config.repository } },
  };
  view = await flows.view(id);
  assert.equal(view.destination.locked, true);
  assert.equal(view.destination.branch, 'dev');
  pr.base.ref = 'release';
  view = await flows.view(id);
  assert.equal(view.destination.branch, 'dev');
  assert.equal(view.destination.proposedBranch, 'release');
  await act('accept-pr-base', { branch: 'release' });
  assert.equal(view.destination.branch, 'release');
  assert.equal(view.destination.proposedBranch, undefined);
  assert.equal(view.flow.startingPoint.ref, 'refs/remotes/upstream/recent');
});

test('A published PR supersedes the earlier missing-PR Merge attempt after reload', (t) => {
  const { id, root, service } = fixture(t);
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  const publish = flow.blocks.find(({ kind }) => kind === 'publish');
  const merge = flow.blocks.find(({ kind }) => kind === 'merge');
  const missing = {
    id: 'early-merge',
    status: 'blocked',
    startedAt: '2026-11-18T14:00:00.000Z',
    endedAt: '2026-11-18T14:00:01.000Z',
    summary: 'No PR exists for codex/fixture. Publish the issue PR first.',
  };
  flow.workspace = { checkout: root, branch: 'codex/fixture' };
  merge.attempts.push(missing);
  const saved = flows.store.save(flow, flow.revision);
  assert.deepEqual(latestCurrentAttempt(flows.read(issue).blocks.find(({ kind }) => kind === 'merge')), missing);

  const publishedAt = '2026-11-18T14:01:01.000Z';
  flow.destination = { branch: 'dev', pr: 87 };
  publish.attempts.push({ status: 'completed', endedAt: publishedAt, result: { pr: 87 } });
  // Write the old record format directly to exercise recovery for existing issues.
  writeFileSync(flows.store.path(id), JSON.stringify({ ...flow, revision: saved.revision }));
  const reloaded = flows.read(issue);
  const recoveredMerge = reloaded.blocks.find(({ kind }) => kind === 'merge');
  assert.equal(latestCurrentAttempt(recoveredMerge), undefined);
  assert.deepEqual(recoveredMerge.attempts, [{ ...missing, invalidatedAt: publishedAt, supersededByPR: 87 }]);

  const laterFailure = { ...missing, id: 'new-merge', endedAt: '2026-11-18T14:02:01.000Z' };
  recoveredMerge.attempts.push(laterFailure);
  flows.store.save(reloaded, reloaded.revision);
  assert.deepEqual(latestCurrentAttempt(flows.read(issue).blocks.find(({ kind }) => kind === 'merge')), laterFailure);
});

test('project setup previews and creates only the missing lifecycle without changing reports or policy', (t) => {
  const { root, id, service } = fixture(t);
  const reportPath = join(root, '.issues', id + '.md');
  const report = readFileSync(reportPath, 'utf8');
  const before = readProjectSettings(root);
  assert.equal(before.lifecycle.present, false);
  assert.equal(existsSync(join(root, before.lifecycle.path)), false);
  assert.throws(() => initializeProjectLifecycle(service, { digest: 'stale' }), /preview changed/);
  const saved = initializeProjectLifecycle(service, { digest: before.lifecycle.digest, humanInputPolicy: {} });
  assert.equal(saved.lifecycle.present, true);
  assert.equal(saved.lifecycle.content, before.lifecycle.content);
  assert.deepEqual(saved.humanInputPolicy, before.humanInputPolicy);
  assert.equal(saved.humanInputPolicy.require_explicit_acceptance, true);
  assert.equal(readFileSync(reportPath, 'utf8'), report);
  assert.equal(existsSync(join(root, '.issues/preferences.json')), false);
  writeFileSync(join(root, before.lifecycle.path), 'Custom project states.\n');
  assert.equal(
    initializeProjectLifecycle(service, { digest: before.lifecycle.digest }).lifecycle.content,
    'Custom project states.\n'
  );
  service.ownServer = () => {
    throw Error('Another server owns the project.');
  };
  assert.throws(() => initializeProjectLifecycle(service, { digest: before.lifecycle.digest }), /Another server/);
});

test('initialized lifecycle works with the actual human-input guard and retains required human checks', (t) => {
  const { root, id, service } = fixture(t);
  const helperDirectory = join(root, '.agents/skills/issues/scripts');
  mkdirSync(helperDirectory, { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    cpSync(new URL('../.agents/skills/issues/scripts/' + file, import.meta.url), join(helperDirectory, file));
  initializeProjectLifecycle(service, { digest: readProjectSettings(root).lifecycle.digest });
  const action = { id: 'setup-test', issues: [id] };
  assert.equal(humanGuard(root, action, 'implement', null)[0].id, id);
  const path = join(root, '.issues', id + '.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '\nstate: backlog\n',
      '\nstate: backlog\nhuman_checks:\n  - id: device\n    kind: evidence\n    blocks: dependent-work\n    status: pending\n    instructions: Check the device.\n    revision: current\n    result: null\n'
    )
  );
  assert.throws(() => humanGuard(root, action, 'implement', null), /Human input blocks implement/);
});

test('new issues start at the destination branch while explicit starting points stay with their issue', async (t) => {
  const { root, git, id, service } = fixture(t);
  const tree = git('rev-parse', 'HEAD^{tree}');
  const commit = (date) =>
    execFileSync('git', ['-C', root, 'commit-tree', tree, '-m', 'Dated branch tip'], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: 'utf8',
    }).trim();
  const recent = commit('2030-01-02T12:00:00Z');
  const older = commit('2000-01-01T12:00:00Z');
  git('branch', 'recent', recent);
  git('branch', 'same-tip', recent);
  git('branch', 'older', older);
  git('update-ref', 'refs/remotes/origin/recent', recent);
  git('update-ref', 'refs/remotes/origin/dev', older);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/recent');
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  t.after(() => flows.close());
  const before = await flows.view(id);
  const refs = before.branches.map((branch) => branch.ref);
  for (const ref of ['refs/heads/recent', 'refs/heads/same-tip', 'refs/remotes/origin/recent']) {
    assert.ok(refs.includes(ref), 'Missing a branch sharing the same commit.');
    assert.ok(refs.indexOf(ref) < refs.indexOf('refs/heads/older'));
  }
  assert.ok(!refs.includes('refs/remotes/origin/HEAD'));
  for (let index = 1; index < before.branches.length; index += 1)
    assert.ok(Number(before.branches[index - 1].committedAt) >= Number(before.branches[index].committedAt));
  const currentBranch = git('branch', '--show-current');
  const selected = await flows.action({
    action: 'starting-point',
    issueId: id,
    revision: before.flow.revision,
    ref: 'refs/heads/recent',
  });
  assert.deepEqual(startingPoint(selected.flow), { ref: 'refs/heads/recent', name: 'recent', commit: recent });
  assert.deepEqual(deliveryTarget(selected.flow), { ...deliveryTarget(before.flow), branch: 'recent' });
  assert.equal(git('branch', '--show-current'), currentBranch);
  writeFileSync(join(root, '.issues/flows/defaults.json'), JSON.stringify({ startingRef: 'refs/heads/recent' }));
  const restarted = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  t.after(() => restarted.close());
  assert.equal(startingPoint((await restarted.view(id)).flow).commit, recent);
  git('update-ref', 'refs/heads/recent', older);
  const input = {
    action: 'capture',
    folder: 'Inbox',
    requestId: '00000000-0000-4000-8000-000000000121',
    type: 'feature',
    description: 'Start the next issue on the delivery branch',
  };
  const captured = await restarted.action(input);
  assert.deepEqual(startingPoint(captured.flow), { ref: 'refs/remotes/origin/dev', name: 'origin/dev', commit: older });
  assert.equal(deliveryTarget(captured.flow).branch, 'dev');
  git('update-ref', 'refs/remotes/origin/dev', recent);
  assert.equal(
    startingPoint((await restarted.action(input)).flow).commit,
    older,
    'Capture retry changed its original starting commit.'
  );
  const latest = await restarted.view(id);
  await assert.rejects(() =>
    restarted.action({ action: 'starting-point', issueId: id, revision: latest.flow.revision, ref: '--help' })
  );
  const attempted = structuredClone(latest.flow);
  attempted.blocks
    .find((block) => block.id === 'work')
    .attempts.push({ id: 'retained', status: 'completed', startedAt: '2026-11-13T12:00:00Z' });
  restarted.store.save(attempted, attempted.revision);
  const locked = await restarted.view(id);
  assert.equal(locked.startingPointEditable, false);
  await assert.rejects(() =>
    restarted.action({ action: 'starting-point', issueId: id, revision: locked.flow.revision, ref: 'refs/heads/older' })
  );
  assert.equal(startingPoint((await restarted.view(id)).flow).commit, recent);
  git('branch', '-D', 'recent');
  git('update-ref', '-d', 'refs/remotes/origin/dev');
  const local = await restarted.action({ ...input, requestId: '00000000-0000-4000-8000-000000000122' });
  assert.equal(startingPoint(local.flow).ref, 'refs/heads/dev');
});

test('changing a started issue branch moves its work and retains its prior attempt', async (t) => {
  const { root, git, id, service } = fixture(t);
  writeFileSync(join(root, '.issues/triage-labels.md'), 'Configured for the test guard.');
  service.guard = () => {};
  const initial = git('rev-parse', 'HEAD');
  git('switch', '-c', 'correct');
  writeFileSync(join(root, 'correct.txt'), 'Correct starting branch\n');
  git('add', 'correct.txt');
  git('commit', '-m', 'Correct branch work');
  const correct = git('rev-parse', 'HEAD');
  git('switch', 'dev');
  writeFileSync(join(root, 'wrong.txt'), 'Wrong starting branch\n');
  git('add', 'wrong.txt');
  git('commit', '-m', 'Wrong branch work');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'conflict', initial);
  writeFileSync(join(root, 'source.txt'), 'conflicting change\n');
  git('commit', '-am', 'Conflicting branch work');
  const checkout = join(realpathSync(root), '.issues/issue-work', id);
  git('worktree', 'add', '-b', 'codex/test-issue', checkout, base);
  const issueGit = (...args) => git('-C', checkout, ...args);
  writeFileSync(join(checkout, 'source.txt'), 'issue change\n');
  writeFileSync(join(checkout, 'extra.txt'), 'uncommitted new file\n');
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  t.after(() => flows.close());
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.startingPoint = { ref: 'refs/heads/dev', name: 'dev', commit: base };
  flow.workspace = { checkout, branch: 'codex/test-issue', base };
  flow.destination = { branch: 'dev' };
  const work = flow.blocks.find((block) => block.kind === 'work');
  work.attempts.push({ id: 'prior-attempt', status: 'completed' });
  flows.store.save(flow, flow.revision);
  const choose = (name) =>
    flows.action({
      action: 'starting-point',
      issueId: id,
      revision: flows.read(issue).revision,
      ref: 'refs/heads/' + name,
      confirmed: true,
    });
  assert.equal((await flows.view(id)).startingPointEditable, true);
  await assert.rejects(choose('conflict'), /original worktree retains them/);
  assert.equal(flows.read(issue).workspace.base, base);
  assert.equal(issueGit('show', 'HEAD:extra.txt'), 'uncommitted new file');
  assert.equal(issueGit('merge-base', base, 'HEAD'), base);
  const moved = await choose('correct');
  assert.equal(moved.flow.startingPoint.commit, correct);
  assert.equal(moved.flow.workspace.base, correct);
  assert.equal(deliveryTarget(moved.flow).branch, 'dev');
  assert.equal(issueGit('branch', '--show-current'), 'codex/test-issue');
  assert.equal(issueGit('merge-base', correct, 'HEAD'), correct);
  assert.equal(issueGit('status', '--porcelain'), '');
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'issue change\n');
  assert.equal(readFileSync(join(checkout, 'extra.txt'), 'utf8'), 'uncommitted new file\n');
  assert.equal(existsSync(join(checkout, 'wrong.txt')), false);
  assert.ok(moved.flow.blocks.find((block) => block.id === work.id).attempts[0].invalidatedAt);
});

test('request data and block order persist with revision conflicts rejected', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  let view = await flows.view(id);
  assert.match(requestData(view.flow).wording, /Saved value persists after reload/);
  assert.equal(view.flow.routeType, 'bug');
  const request = view.flow.blocks[0].id;
  assert.equal((await flows.view(id)).flow.blocks[0].id, request);
  view = await flows.action({
    issueId: id,
    revision: 0,
    action: 'add',
    kind: 'repro',
    afterId: view.flow.blocks.find((block) => block.kind === 'work').id,
  });
  assert.equal(view.flow.blocks[2].kind, 'repro');
  assert.equal(view.flow.blocks[3].kind, 'publish');
  await assert.rejects(flows.action({ issueId: id, revision: 0, action: 'folder', folder: 'Stale' }), /flow changed/);
  const reloaded = createIssueFlows(service, { executor: executor(async () => ({})) });
  assert.equal((await reloaded.view(id)).flow.blocks[2].kind, 'repro');
  assert.ok(existsSync(join(root, '.issues/flows', id, 'flow.json')));
});

test('Request saves the full regression setting across reloads and rejects stale edits', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({})) });
  const { flow } = await flows.view(id);
  assert.notEqual(requestData(flow).fullRegression, true);
  const toggle = (revision, enabled) =>
    flows.action({ issueId: id, revision, action: 'full-regression-setting', enabled });
  const saved = await toggle(flow.revision, true);
  await assert.rejects(toggle(flow.revision, false), /flow changed/);
  const reloaded = createIssueFlows(service, { executor: executor(async () => ({})) });
  assert.equal(requestData((await reloaded.view(id)).flow).fullRegression, true);
  assert.equal(requestData((await toggle(saved.flow.revision, false)).flow).fullRegression, false);
});

test('a block runs only on explicit start and retry retains both attempts', async (t) => {
  const { id, service } = fixture(t);
  let calls = 0;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ onProgress }) => {
      calls++;
      onProgress('actual output');
      if (calls === 1) throw Error('command failed');
      return { summary: 'finished', evidence: [] };
    }),
  });
  await flows.view(id);
  await flows.view(id);
  assert.equal(calls, 0);
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'start' });
  await flows.active.get(id)?.task;
  let view = await flows.view(id);
  assert.equal(view.flow.blocks.find((block) => block.id === 'work').attempts[0].status, 'blocked');
  assert.equal(view.flow.blocks.find((block) => block.id === 'work').attempts[0].output, 'actual output');
  await flows.action({ issueId: id, revision: view.flow.revision, blockId: 'work', action: 'continue' });
  await flows.active.get(id)?.task;
  view = await flows.view(id);
  assert.deepEqual(
    view.flow.blocks.find((block) => block.id === 'work').attempts.map((a) => a.status),
    ['blocked', 'completed']
  );
  assert.equal(calls, 2);
  assert.equal(
    view.flow.blocks.some((block) => block.kind === 'verify'),
    false
  );
});

test('stop stays available while progress revisions advance and retains partial output', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(({ signal, onProgress }) => {
      onProgress('started');
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('interrupted')), { once: true })
      );
    }),
  });
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'start' });
  const task = flows.active.get(id).task;
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'stop' });
  await task;
  const view = await flows.view(id);
  assert.equal(view.flow.blocks.find((block) => block.id === 'work').attempts[0].status, 'stopped');
  assert.equal(view.flow.blocks.find((block) => block.id === 'work').attempts[0].output, 'started');
});

test('external target changes and worktree deletion are observed without starting work', async (t) => {
  const { root, id, git, service } = fixture(t);
  const checkout = join(root, '.issues/work');
  git('worktree', 'add', '-qb', 'codex/test', checkout, 'dev');
  const issue = { id, title: 'Test', content: '' };
  const flow = newFlow(issue, { branch: 'dev', remote: 'origin', base: git('rev-parse', 'dev') });
  flow.workspace = { checkout, branch: 'codex/test', base: deliveryTarget(flow).base };
  const store = new FlowStore(root);
  store.save(flow, 0);
  const observer = createFlowObserver(service);
  assert.equal((await observer.observe(flow)).behind, 0);
  writeFileSync(join(root, 'source.txt'), 'changed target');
  git('add', 'source.txt');
  git('commit', '-qm', 'advance');
  git('branch', '-f', 'dev', 'HEAD');
  const destinationOnly = await observer.observe(flow);
  assert.equal(destinationOnly.behind, 1);
  assert.equal(destinationOnly.startingBranchBehind, undefined);
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  const observed = await observer.observe(flow);
  assert.equal(observed.startingBranchBehind, 1);
  assert.equal(observed.behind, 1);
  assert.equal(observed.targetRevision, git('rev-parse', 'dev'));
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Error('must not execute');
    }),
  });
  const view = await flows.view(id);
  assert.equal(view.flow.blocks.filter((b) => b.kind === 'update-branch').length, 1);
  git('worktree', 'remove', checkout);
  assert.equal((await observer.observe(flow)).worktreeExists, false);
});

test('a changed Request type applies its default Markdown flow and preserves earlier history', async (t) => {
  const { service, id } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Error('not requested');
    }),
    clarify: async (_root, _definition, attempt) => ({
      artifacts: {
        values: { type: 'investigation', goal: attempt.details.find((item) => item.key === 'wording').value },
      },
    }),
  });
  await flows.action({ action: 'create-folder', name: 'Next release' });
  let view = await flows.action({ issueId: id, revision: 0, action: 'folder', folder: 'Next release' });
  assert.equal(view.flow.folder, 'Next release');
  view = await flows.action({
    issueId: id,
    revision: view.flow.revision,
    action: 'request',
    wording: 'Understand saving',
  });
  assert.equal(view.flow.routeType, 'investigation');
  assert.equal(view.flow.definition.id, 'investigation');
  assert.equal(requestData(view.flow).fields.goal, 'Understand saving');
  assert.ok(view.flow.retiredBlocks.some((block) => block.kind === 'work'));
  view = await flows.action({
    issueId: id,
    revision: view.flow.revision,
    action: 'comment',
    blockId: view.flow.blocks.find((block) => block.kind === 'investigate').id,
    text: 'Keep the original wording.',
  });
  assert.equal(view.flow.blocks.find((item) => item.kind === 'investigate').comments.length, 1);
  const input = {
    action: 'capture',
    requestId: '00000000-0000-4000-8000-000000000001',
    type: 'feature',
    description: 'Create a compact view\nDone: Three columns are visible.',
    folder: 'Next release',
  };
  const captured = await flows.action(input);
  assert.equal(captured.flow.folder, 'Next release');
  assert.equal(captured.flow.routeType, 'feature');
  assert.match(requestData(captured.flow).wording, /Three columns are visible/);
  assert.equal((await flows.action(input)).issue.id, captured.issue.id);
  assert.equal((await flows.view()).issues.length, 2);
});

test('folder scans move only eligible recommendations and locked issues keep their folder', async (t) => {
  const { service, id } = fixture(t);
  const suggested = [];
  const flows = (service.flows = createIssueFlows(service, {
    executor: executor(async () => assert.fail('A folder operation cannot start issue work')),
    recommendFolderIssues: async (strategy, candidates) => {
      suggested.push({ strategy, ids: candidates.map((candidate) => candidate.id) });
      return candidates.map(({ id }) => ({ id, reason: 'Both reports concern saved values.' }));
    },
  }));
  await flows.action({ action: 'create-folder', name: 'Save fixes' });
  await flows.action({ action: 'create-folder', name: 'Later' });
  const scan = {
    action: 'folder-scan',
    folder: 'Save fixes',
    strategy: 'same-blast-radius',
    sourceFolder: null,
  };
  const preview = await flows.action(scan);
  assert.deepEqual(
    preview.candidates.map((candidate) => candidate.id),
    [id]
  );

  const lock = { action: 'folder-lock', issueId: id };
  let view = await flows.action({ ...lock, revision: 0, locked: true });
  assert.equal(view.flow.folderLocked, true);
  await assert.rejects(
    flows.action({ action: 'folder-move', folder: scan.folder, scanId: preview.id, issueIds: [id] }),
    /no longer eligible/
  );
  await assert.rejects(
    flows.action({ action: 'folder', issueId: id, revision: view.flow.revision, folder: scan.folder }),
    /protected/
  );
  assert.deepEqual((await flows.action({ ...scan, autoApprove: true })).candidates, []);
  assert.equal(suggested.length, 1);

  await flows.action({ ...lock, revision: view.flow.revision, locked: false });
  assert.equal((await flows.action({ ...scan, autoApprove: true })).moved, 1);
  view = await flows.view(id);
  assert.equal(view.flow.folder, scan.folder);
  view = await flows.action({ ...lock, revision: view.flow.revision, locked: true });
  await assert.rejects(
    flows.action({ action: 'folder', issueId: id, revision: view.flow.revision, folder: 'Later' }),
    /protected/
  );
  await assert.rejects(
    flows.action({ action: 'folder-remove', folder: scan.folder, issueIds: [id] }),
    /needs a folder/
  );
  view = await flows.view(id);
  assert.equal(view.flow.folder, scan.folder);
  assert.equal(view.flow.folderLocked, true);
});

test('issue creation uses the default folder and explicit creation or moves require an existing folder', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({})) });
  const view = await flows.view(id);
  assert.equal(view.flow.folder, 'Inbox');
  const capture = {
    action: 'capture',
    requestId: '00000000-0000-4000-8000-000000000122',
    description: 'Keep every issue in a folder',
  };
  for (const folder of [undefined, null, '', 'Missing folder']) {
    if (folder === 'Missing folder') await assert.rejects(flows.action({ ...capture, folder }), /[Cc]hoose.*folder/);
    else assert.equal((await flows.action({ ...capture, folder })).flow.folder, 'Inbox');
    await assert.rejects(
      flows.action({ action: 'folder', issueId: id, revision: view.flow.revision, folder }),
      /folder/
    );
  }
  const created = await flows.action({ ...capture, folder: 'Inbox' });
  assert.ok(flows.selected(created.issue.id).folder_id);
  assert.equal(created.flow.folder, 'Inbox');
  assert.equal((await flows.view(id)).flow.folder, 'Inbox');
});

test('folder deletion preserves assigned issues and blocks new assignments during Trash', async (t) => {
  const { root, id, service } = fixture(t);
  const begun = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const destination = join(root, 'Trashed folder');
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({})),
    async trashDirectory(path) {
      begun.resolve();
      await finish.promise;
      renameSync(path, destination);
    },
  });
  const inbox = flows.previewFolderDeletion({ root: 'user', path: 'Inbox' });
  assert.equal(inbox.canDelete, false);
  await assert.rejects(flows.deleteFolder({ root: 'user', path: 'Inbox', basis: inbox.basis }), /assigned issues/);
  assert.equal(flows.previewFolderDeletion({ root: 'system-flow', path: '' }).installed, true);
  await flows.action({ action: 'create-folder', name: 'Empty folder' });
  const selection = { root: 'user', path: 'Empty folder' };
  const preview = flows.previewFolderDeletion(selection);
  writeFileSync(join(root, 'user/Empty folder/notes.md'), '# Keep these notes');
  await assert.rejects(flows.deleteFolder({ ...selection, basis: preview.basis }), /folder changed/);
  const current = flows.previewFolderDeletion(selection);
  const deletion = flows.deleteFolder({ ...selection, basis: current.basis });
  await begun.promise;
  try {
    const view = await flows.view(id);
    await assert.rejects(
      flows.action({ action: 'folder', issueId: id, revision: view.flow.revision, folder: 'Empty folder' }),
      /being moved to Trash/
    );
  } finally {
    finish.resolve();
  }
  assert.deepEqual(await deletion, { trashed: true });
  assert.equal(readFileSync(join(destination, 'notes.md'), 'utf8'), '# Keep these notes');
  assert.equal(existsSync(join(root, 'user/Empty folder')), false);
  assert.equal((await flows.view(id)).flow.folder, 'Inbox');
});

test('folder migration assigns older open, closed and archived reports to Inbox', async (t) => {
  const { root, id, service } = fixture(t);
  const content = readFileSync(join(root, '.issues', id + '.md'), 'utf8');
  for (const location of ['closed', 'archive']) {
    mkdirSync(join(root, '.issues', location));
    writeFileSync(
      join(root, '.issues', location, id + '-' + location + '.md'),
      content.replace('id: ' + id, 'id: ' + id + '-' + location).replace('state: backlog', 'state: closed')
    );
  }
  const flows = createIssueFlows(service, { executor: executor(async () => ({})) });
  const migrated = await flows.action({ action: 'migrate-folders' });
  assert.equal(migrated.migratedIssues, 3);
  const folderId = flows.selected(id).folder_id;
  assert.ok(folderId);
  for (const suffix of ['', '-closed', '-archive']) {
    assert.equal(flows.selected(id + suffix).folder_id, folderId);
    assert.equal((await flows.view(id + suffix)).flow.folder, 'Inbox');
  }
  assert.equal((await flows.action({ action: 'migrate-folders' })).migratedIssues, 0);
});

test('moving an existing issue folder preserves report membership by ID', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({})) });
  const issue = flows.selected(id);
  const legacy = flows.read(issue);
  legacy.folder = 'Releases';
  flows.store.save(legacy, legacy.revision);
  writeFileSync(join(flows.store.directory, 'folders.json'), JSON.stringify(['Releases']));
  const migration = await flows.action({ action: 'migrate-folders' });
  assert.equal(migration.migratedIssues, 1);
  assert.equal((await flows.view(id)).flow.folder, 'Releases');
  const assignment = flows.selected(id).folder_id;
  assert.match(readFileSync(join(root, 'user/Releases/folder.md'), 'utf8'), new RegExp(assignment));
  renameSync(join(root, 'user/Releases'), join(root, 'user/Shipping'));
  assert.equal((await flows.view(id)).flow.folder, 'Shipping');
  assert.equal(flows.selected(id).folder_id, assignment);
  renameSync(join(root, 'user/Shipping'), join(root, 'Detached'));
  assert.equal((await flows.view(id)).flow.folder, 'Releases');
  renameSync(join(root, 'Detached'), join(root, 'user/Shipping'));
  assert.equal((await flows.view(id)).flow.folder, 'Shipping');
  cpSync(join(root, 'user/Shipping'), join(root, 'user/Copy'), { recursive: true });
  assert.equal((await flows.view(id)).flow.folder, 'Releases');
  const copy = giveIssueFolderCopyNewId(root, 'Copy');
  assert.notEqual(copy.id, assignment);
  assert.equal((await flows.view(id)).flow.folder, 'Shipping');
});

test('project defaults append, builders run once, and Markdown changes apply only on request', async (t) => {
  const { root, service } = fixture(t);
  const extensionDir = join(root, 'user/flow/extensions');
  mkdirSync(join(extensionDir, 'definitions'), { recursive: true });
  const promptPath = join(extensionDir, 'definitions/delivery.md');
  writeFileSync(promptPath, 'Start with the **review** block.\n');
  const customDir = join(root, 'user/flow/definitions');
  mkdirSync(customDir, { recursive: true });
  writeFileSync(
    join(customDir, 'quick.md'),
    `---
name: Quick check
issueTypes: [bug]
blocks:
  - { id: request, block: request }
  - { id: target, block: target, after: [request] }
  - { id: verify, block: verify, after: [target] }
---
`
  );
  writeFileSync(join(extensionDir, 'defaults.md'), '---\ndefaults:\n  bug: quick\n---\n');
  const prompts = [];
  const flows = createIssueFlows(service, {
    buildStructure: async ({ definition }) => {
      prompts.push(definition.prompt);
      return [...definition.blocks, { id: 'review', block: 'advice', after: ['work'], lane: 1 }];
    },
  });
  async function capture(type, suffix) {
    return flows.action({
      action: 'capture',
      folder: 'Inbox',
      requestId: '00000000-0000-4000-8000-00000000000' + suffix,
      type,
      description: 'Check saving',
    });
  }
  const bug = await capture('bug', 2);
  assert.equal(bug.flow.definition.id, 'quick');
  assert.deepEqual(
    bug.flow.blocks.map((block) => block.kind),
    ['request', 'verify']
  );
  const [feature, sameCapture] = await Promise.all([capture('feature', 3), capture('feature', 3)]);
  assert.equal(feature.issue.id, sameCapture.issue.id);
  assert.equal(feature.flow.definition.id, 'delivery');
  assert.equal(feature.flow.blocks.at(-1).kind, 'advice');
  assert.deepEqual(feature.flow.blocks.at(-1).after, ['work']);
  assert.deepEqual(
    feature.flowDefinitions.available.map(({ id }) => id),
    ['delivery']
  );
  assert.deepEqual(prompts, ['Start with the **review** block.']);
  const featureId = feature.issue.id;
  writeFileSync(promptPath, 'Start with the\nreview   block.\n');
  assert.equal((await flows.view(featureId)).flowDefinitions.updated, false);
  writeFileSync(promptPath, 'Start with the **design** block.\n');
  const pending = await flows.view(featureId);
  assert.equal(pending.flowDefinitions.updated, true);
  assert.equal(pending.flow.definition.checksum, feature.flow.definition.checksum);
  assert.equal(prompts.length, 1);
  const updated = await flows.action({ action: 'rebuild-flow', issueId: featureId, revision: pending.flow.revision });
  assert.equal(updated.flowDefinitions.updated, false);
  assert.equal(prompts.length, 2);
  const saved = editFlow(flows.read(flows.selected(bug.issue.id)), { action: 'add', kind: 'verify' });
  const result = { id: 'prior-verify', status: 'completed', summary: 'Original verification result' };
  saved.blocks.find((block) => block.kind === 'verify').attempts.push(result);
  const withResult = flows.store.save(saved, saved.revision);
  const switched = await flows.action({
    action: 'select-flow',
    flowId: 'delivery',
    issueId: bug.issue.id,
    revision: withResult.revision,
  });
  assert.equal(switched.flow.definition.id, 'delivery');
  assert.equal(prompts.length, 3);
  assert.deepEqual(switched.flow.retiredBlocks.find((block) => block.kind === 'verify').attempts, [result]);
  const rebuilt = await flows.action({
    action: 'rebuild-flow',
    issueId: bug.issue.id,
    revision: switched.flow.revision,
  });
  assert.equal(rebuilt.flow.definition.checksum, switched.flow.definition.checksum);
  assert.equal(prompts.length, 4, 'The wand rebuilds even when the definition is unchanged.');
  assert.deepEqual(rebuilt.flow.retiredBlocks.find((block) => block.kind === 'verify').attempts, [result]);
});

test('extension frontmatter replaces the block list before the builder reads both prompts', async (t) => {
  const { root, id, service } = fixture(t);
  const directory = join(root, 'user/flow/definitions');
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'team'));
  writeFileSync(
    join(directory, 'review.md'),
    `---
name: Team review
issueTypes: [bug]
skill: Team_Review
extension: team/review.md
blocks:
  - { id: request, block: request }
  - { id: work, block: work, after: [request] }
---

# Prompt

Base instructions.
`
  );
  writeFileSync(
    join(root, 'team/review.md'),
    `---
blocks:
  - { id: request, block: request }
  - { id: verify, block: verify, after: [request] }
---

# Prompt

Team instructions.
`
  );
  const flows = createIssueFlows(service, {
    buildStructure: async ({ definition }) => {
      assert.deepEqual(
        definition.blocks.map(({ id }) => id),
        ['request', 'verify']
      );
      assert.equal(definition.prompt, 'Base instructions.\n\nTeam instructions.');
      return [definition.blocks[0], { id: 'design', block: 'design', after: ['request'] }];
    },
  });
  const updated = await flows.action({ action: 'select-flow', issueId: id, revision: 0, flowId: 'review' });
  assert.deepEqual(updated.flowDefinitions.exportSuggestion, {
    flowId: 'team-review',
    directory: 'user/flow/definitions',
  });
  assert.deepEqual(
    updated.flow.blocks.map(({ kind }) => kind),
    ['request', 'design']
  );
  assert.equal(updated.flow.target.branch, 'dev');
  flows.buildStructure = async () => [{ id: 'design', block: 'design' }];
  await assert.rejects(
    flows.action({ action: 'rebuild-flow', issueId: id, revision: updated.flow.revision }),
    /Start the flow with the Request block/
  );
  assert.deepEqual(
    (await flows.view(id)).flow.blocks.map(({ kind }) => kind),
    ['request', 'design']
  );
});

test('old Target records preserve branches, dependencies and earlier progress', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service);
  const flow = flows.read(flows.selected(id));
  const starting = { name: 'saved', ref: 'refs/heads/saved', commit: 'a'.repeat(40) };
  const delivery = { branch: 'release', remote: 'upstream', base: null };
  delete flow.target;
  delete flow.startingPoint;
  const oldTarget = {
    id: 'old-target',
    kind: 'target',
    after: ['request'],
    attempts: [],
    comments: [{ text: 'Keep the original branch.' }],
    data: { delivery, startingPoint: starting },
  };
  flow.blocks.splice(1, 0, oldTarget);
  const work = flow.blocks.find(({ kind }) => kind === 'work');
  work.after = ['request', 'old-target'];
  work.attempts.push({ id: 'saved-work', status: 'completed' });
  flow.blocks.find(({ kind }) => kind === 'publish').links = { delivery: 'old-target' };
  flows.store.save(flow, 0);
  let view = await flows.view(id);
  assert.deepEqual(view.flow.target, delivery);
  assert.deepEqual(view.flow.startingPoint, starting);
  assert.ok(view.flow.blocks.every(({ kind }) => kind !== 'target'));
  assert.deepEqual(view.flow.retiredBlocks, [oldTarget]);
  assert.deepEqual(view.flow.blocks.find(({ kind }) => kind === 'work').after, ['request']);
  const publish = view.flow.blocks.find(({ kind }) => kind === 'publish');
  assert.deepEqual(publish.links, {});
  assert.equal(publish.details.find(({ key }) => key === 'delivery').value, 'saved');
  view = await flows.action({ action: 'rebuild-flow', issueId: id, revision: view.flow.revision });
  assert.deepEqual(view.flow.startingPoint, starting);
  assert.equal(view.flow.blocks.find(({ kind }) => kind === 'work').attempts[0].status, 'completed');
});

test('export links the exact current structure without rebuilding or changing progress', async (t) => {
  const { root, service, id } = fixture(t);
  const flows = createIssueFlows(service, {
    buildStructure: () => assert.fail('Exported flows never call a model builder'),
  });
  const saved = flows.read(flows.selected(id));
  saved.blocks.find((block) => block.kind === 'work').attempts.push({ id: 'progress', status: 'completed' });
  flows.store.save(saved, 0);
  const act = (view, action, input = {}) =>
    flows.action({ issueId: id, revision: view.flow.revision, action, ...input });
  const initial = await flows.view(id);
  const before = await act(initial, 'add', { kind: 'advice', afterId: 'work' });
  assert.equal(before.flow.definition.checksum, initial.flow.definition.checksum);
  const exported = await act(before, 'export-flow', { flowId: 'with-advice', name: 'With advice' });
  assert.equal(exported.flow.definition.id, 'with-advice');
  assert.equal(exported.flowDefinitions.exportSuggestion.flowId, 'with-advice-2');
  assert.equal(exported.flowDefinitions.updated, false);
  const body = readFileSync(join(root, 'user/flow/definitions/with-advice.md'), 'utf8');
  assert.match(body, /block: advice/);
  assert.doesNotMatch(body, /progress|skill:|Build prompt/);
  assert.equal(exported.flow.blocks.find((block) => block.kind === 'work').attempts[0].status, 'completed');
  assert.deepEqual(
    exported.flow.blocks.map((block) => block.id),
    before.flow.blocks.map((block) => block.id)
  );
  const altered = await act(exported, 'add', { kind: 'sharpen', afterId: 'work' });
  const rebuilt = await act(altered, 'rebuild-flow');
  const structure = (view) => view.flow.blocks.map(({ id, after, lane }) => ({ id, after, lane }));
  assert.deepEqual(structure(rebuilt), structure(exported));
  assert.deepEqual(rebuilt.flow.blocks.find((block) => block.kind === 'work').attempts, [
    { id: 'progress', status: 'completed' },
  ]);
  await assert.rejects(() => act(rebuilt, 'select-flow', { flowId: 'investigation' }), /unavailable for bug/);
  const switched = await act(rebuilt, 'select-flow', { flowId: 'delivery' });
  assert.equal(switched.flow.definition.id, 'delivery');
  assert.deepEqual(switched.flow.blocks.find((block) => block.kind === 'work').attempts, [
    { id: 'progress', status: 'completed' },
  ]);
  await assert.rejects(
    () => act(switched, 'export-flow', { flowId: 'with-advice', name: 'Replacement' }),
    /already in use/
  );
  const save = flows.store.save;
  flows.store.save = () => {
    throw Error('Could not link the export.');
  };
  await assert.rejects(
    () => act(switched, 'export-flow', { flowId: 'unlinked', name: 'Unlinked' }),
    /Could not link the export/
  );
  flows.store.save = save;
  assert.equal(existsSync(join(root, 'user/flow/definitions/unlinked.md')), false);
  assert.equal((await flows.view(id)).flow.definition.id, 'delivery');
});

test('block graph rejects cycles and preserves attempted history', (t) => {
  const { root } = fixture(t);
  const flow = newFlow({ id: '20261113-one', title: 'Example', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.blocks.find((block) => block.id === 'work').after = ['close'];
  assert.throws(() => new FlowStore(root).save(flow, 0), /dependencies/);
  flow.blocks.find((block) => block.id === 'work').after = ['request'];
  flow.blocks.find((block) => block.id === 'work').attempts.push({ id: 'attempt', status: 'blocked' });
  const removed = editFlow(flow, { action: 'remove', blockId: 'work' });
  assert.equal(
    removed.blocks.some((block) => block.id === 'work'),
    false
  );
  assert.deepEqual(removed.retiredBlocks[0].attempts, [{ id: 'attempt', status: 'blocked' }]);
});

test('Work waits for its Update Branch prerequisite even when Work uses a parallel lane', async (t) => {
  const { id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'Completed' })) });
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.blocks.find((block) => block.id === 'work').lane = 1;
  const next = editFlow(flow, { action: 'add', kind: 'update-branch' });
  const saved = flows.store.save(next, flow.revision);
  const work = saved.blocks.find((block) => block.id === 'work');
  const update = saved.blocks[saved.blocks.indexOf(work) - 1];
  assert.equal(update.lane, work.lane);
  assert.ok(work.after.includes(update.id));
  const start = (blockId, revision) => flows.action({ action: 'start', issueId: id, blockId, revision });
  await assert.rejects(start(work.id, saved.revision), /Complete Update Branch successfully/);
  await start(update.id, saved.revision);
  await flows.active.get(id)?.task;
  await start(work.id, flows.read(issue).revision);
  await flows.active.get(id)?.task;
});
test('a suggested target update precedes Work in the graph and route execution', { timeout: 5000 }, async (t) => {
  const { root, id, service } = fixture(t);
  const updateStarted = Promise.withResolvers();
  const finishUpdate = Promise.withResolvers();
  const workStarted = Promise.withResolvers();
  const started = [];
  const flows = createIssueFlows(service, {
    observer: {
      async observe() {
        return { startingBranchBehind: 1, startingBranchRevision: 'updated-target' };
      },
    },
    executor: executor(async ({ block }) => {
      started.push(block.kind);
      if (block.kind === 'update-branch') {
        updateStarted.resolve();
        await finishUpdate.promise;
      }
      if (block.kind === 'work') workStarted.resolve();
      return { summary: 'Done' };
    }),
  });
  t.after(() => {
    finishUpdate.resolve();
    flows.close();
  });
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.blocks[0].data.fields = { type: 'bug', goal: 'Repair Save' };
  flow.blocks = flow.blocks.filter((block) => ['request', 'work'].includes(block.kind));
  flow.blocks[1].after = ['request'];
  flow.blocks[1].lane = 1;
  flow.workspace = { checkout: root, branch: 'codex/fixture' };
  const saved = flows.store.save(flow, flow.revision);
  const graph = (await flows.view(id)).flow.blocks;
  assert.deepEqual(
    graph.map((block) => block.id),
    ['request', 'target-updated-target', 'work']
  );
  assert.deepEqual(graph[1].after, ['request']);
  assert.deepEqual(graph[2].after, [graph[1].id]);
  assert.equal(graph[1].lane, graph[2].lane);
  await assert.rejects(
    flows.action({ issueId: id, revision: saved.revision, action: 'start', blockId: 'work' }),
    /Complete the suggested Update Branch/
  );
  assert.equal(flows.read(issue).blocks.length, 2);
  await flows.action({ issueId: id, revision: saved.revision, action: 'play' });
  await updateStarted.promise;
  assert.deepEqual(started, ['update-branch']);
  assert.deepEqual(flows.read(issue).blocks.at(-1).after, ['target-updated-target']);
  finishUpdate.resolve();
  await workStarted.promise;
  await flows.active.get(id)?.task;
  assert.deepEqual(started, ['update-branch', 'work']);
});

test('completed target merges do not hide a later target change and parallel lanes join before suggested publication', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({})),
    observer: {
      async observe() {
        return { startingBranchBehind: 1, startingBranchRevision: 'new-target', observedAt: new Date().toISOString() };
      },
    },
  });
  let flow = flows.read(flows.selected(id));
  flow = editFlow(flow, { action: 'add', kind: 'update-branch' });
  const workIndex = flow.blocks.findIndex((block) => block.kind === 'work');
  assert.equal(flow.blocks[workIndex - 1].label, 'Update Branch');
  assert.ok(flow.blocks[workIndex].after.includes(flow.blocks[workIndex - 1].id));
  flow.blocks
    .find((block) => block.kind === 'update-branch')
    .attempts.push({ id: 'old', status: 'completed', result: { target: 'old-target' } });
  new FlowStore(root).save(flow, 0);
  const view = await flows.view(id);
  assert.ok(view.flow.blocks.some((block) => block.id === 'target-new-target'));
  await flows.action({ action: 'remove', issueId: id, revision: view.flow.revision, blockId: 'target-new-target' });
  assert.ok(!(await flows.view(id)).flow.blocks.some((block) => block.id === 'target-new-target'));
  flow.blocks.find((block) => block.kind === 'publish').suggested = true;
  flow = editFlow(flow, { action: 'add', kind: 'design', lane: 1 });
  const design = flow.blocks.find((block) => block.kind === 'design');
  assert.deepEqual(design.after, ['request']);
  assert.ok(flow.blocks.find((block) => block.kind === 'publish').after.includes(design.id));
  const moved = editFlow(flow, { action: 'move', blockId: design.id, direction: 'down' });
  assert.deepEqual(moved.blocks.find((block) => block.id === design.id).after, ['request']);
});

test('cleanup remains explicitly runnable after issue closure while new code work is refused', async (t) => {
  const { id, root, service } = fixture(t);
  mkdirSync(join(root, '.issues/closed'));
  const { renameSync } = await import('node:fs');
  renameSync(join(root, '.issues', id + '.md'), join(root, '.issues/closed', id + '.md'));
  let ran;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ block }) => {
      ran = block.kind;
      return { summary: 'fixture cleanup' };
    }),
  });
  let view = await flows.view(id);
  await assert.rejects(
    flows.action({ issueId: id, revision: view.flow.revision, blockId: 'work', action: 'start' }),
    /Reopen/
  );
  view = await flows.action({ issueId: id, revision: view.flow.revision, action: 'add', kind: 'delete-worktree' });
  const block = view.flow.blocks.find((item) => item.kind === 'delete-worktree');
  await flows.action({
    issueId: id,
    revision: view.flow.revision,
    blockId: block.id,
    action: 'start',
    confirmed: true,
  });
  await flows.active.get(id)?.task;
  assert.equal(ran, 'delete-worktree');
});

test('opted-in closure holds the worktree until Retro succeeds and files idle approval issues', async (t) => {
  const { id, root, git } = fixture(t);
  cpSync(new URL('../.issues/triage-labels.md', import.meta.url), join(root, '.issues/triage-labels.md'));
  const helperDirectory = join(root, '.agents/skills/issues/scripts');
  mkdirSync(helperDirectory, { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    cpSync(new URL('../.agents/skills/issues/scripts/' + file, import.meta.url), join(helperDirectory, file));
  writeFileSync(join(root, '.gitignore'), '/.issues/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'Ignore fixture runtime');
  const branch = 'codex/issue-' + id;
  const checkout = join(root, '.issues/issue-work', id);
  mkdirSync(join(root, '.issues/issue-work'));
  git('worktree', 'add', '-qb', branch, checkout);
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const proposals = ['Keep this proposal', 'Remove this proposal'].map((title) => ({
    title,
    description: 'Follow-up description.',
    reason: 'Observed friction.',
    verification: 'Re-run the check.',
    requestId: randomUUID(),
  }));
  let retroRuns = 0;
  const releaseRetro = Promise.withResolvers();
  const flows = (service.flows = createIssueFlows(service, {
    deliveryOptions: {
      runRetro: async () => {
        retroRuns++;
        assert.equal(existsSync(checkout), retroRuns <= 2);
        if (retroRuns !== 2) throw Error('Retro fixture failed');
        await releaseRetro.promise;
        return { summary: 'Retro completed.', recommendations: proposals };
      },
    },
  }));
  let flow = flows.read(flows.selected(id));
  flow.workspace = { checkout, branch, base: git('rev-parse', 'HEAD') };
  flows.store.save(flow, flow.revision);
  const submit = (view, action, extra) =>
    flows.action({
      issueId: view.issue.id,
      revision: view.flow.revision,
      action,
      ...extra,
    });
  const waitUntil = async (condition) => {
    for (let index = 0; index < 200; index++) {
      if (condition()) return;
      await delay(20);
    }
    assert.fail('The expected closure state was not reached.');
  };
  let view = await flows.view(id);
  assert.equal(
    view.flow.blocks.some((item) => item.kind === 'retro'),
    false
  );
  view = await submit(view, 'retro-setting', { enabled: true });
  assert.equal(
    view.flow.blocks.some((item) => item.kind === 'retro'),
    true
  );
  const queue = readQueue(root, { issueId: id });
  const issue = queue.issues[0];
  flows.closeWithReason({
    issueId: id,
    flowRevision: view.flow.revision,
    state: issue.state,
    basis: decisionBasis(queue, issue),
    resolution: 'duplicate',
    reason: 'Fixture.',
  });
  const read = () => flows.read(flows.selected(id));
  await waitUntil(
    () =>
      read()
        .blocks.find((item) => item.kind === 'retro')
        ?.attempts.at(-1)?.status === 'blocked'
  );
  assert.equal(flows.selected(id).closed, true);
  assert.equal(existsSync(checkout), true);
  assert.equal(read().blocks.find((item) => item.kind === 'cleanup').attempts.length, 0);
  await waitUntil(() => !flows.closureBusy(id));
  const deletion = await submit(await flows.view(id), 'delete-worktree');
  assert.equal(deletion.path, realpathSync(checkout));
  assert.equal(
    flows.issues().some((item) => item.state === 'needs-approval'),
    false
  );
  await submit(await flows.view(id), 'retry-closure');
  await waitUntil(() => retroRuns === 2);
  assert.equal(flows.closureBusy(id), true);
  await assert.rejects(submit(await flows.view(id), 'delete-worktree', { expected: deletion }), /still in progress/);
  const archive = await moveIssueStorage(service, { action: 'archive', issueIds: [id] });
  assert.equal(archive.results[0].status, 'archived');
  assert.equal((await flows.view(id)).issue.location, 'archive');
  assert.equal(
    flows.issues().some((item) => item.id === id),
    false
  );
  releaseRetro.resolve();
  await waitUntil(() => read().closing.complete);
  assert.equal(existsSync(checkout), false);
  assert.equal(git('rev-parse', branch), git('rev-parse', 'HEAD'));
  const children = flows.issues().filter((item) => item.state === 'needs-approval');
  assert.equal(children.length, 2);
  const [keep, remove] = proposals.map(({ title }) => children.find((child) => child.title === title));
  const pending = await flows.view(keep.id);
  assert.equal(pending.flow.folder, 'Retro items');
  await assert.rejects(submit(pending, 'play'), /Approve/);
  const approved = await submit(pending, 'approve-issue');
  assert.equal(approved.issue.state, 'backlog');
  assert.equal(approved.issue.issueNumber, pending.issue.issueNumber);
  assert.equal(approved.flow.folder, 'Retro items');
  assert.equal(
    approved.flow.blocks.every((item) => item.attempts.length === 0),
    true
  );
  await submit(await flows.view(remove.id), 'delete-pending-issue', { title: remove.title });
  await flows.fileRetroItems(proposals, id);
  assert.equal(
    flows.issues().some((item) => item.id === remove.id),
    false
  );
  assert.equal(flows.issues().filter((item) => item.title === keep.title).length, 1);

  const context = flows.cleanupContext(id);
  const local = issueCleanupIdentities(context, id).resources.find((item) => item.kind === 'local-branch');
  const { resource } = await previewIssueCleanupResource(context, id, local.id);
  assert.equal(resource.eligible, true);
  await submit(await flows.view(id), 'cleanup-again', { cleanup: { selectedResources: [resource] } });
  await waitUntil(() => read().closing.complete && !flows.closureBusy(id));
  assert.equal(git('branch', '--list', branch), '');

  const previousClosure = read().closing.id;
  const restore = await moveIssueStorage(service, { action: 'restore', issueIds: [id] });
  assert.equal(restore.results[0].status, 'restored');
  const closedQueue = readQueue(root, { issueId: id, location: 'closed' });
  const closedIssue = closedQueue.issues[0];
  service.decideIssue(id, closedIssue.state, 'reopen', decisionBasis(closedQueue, closedIssue));
  flows.reopened(id);
  const reopenedQueue = readQueue(root, { issueId: id });
  const reopened = reopenedQueue.issues[0];
  flows.closeWithReason({
    issueId: id,
    flowRevision: read().revision,
    state: reopened.state,
    basis: decisionBasis(reopenedQueue, reopened),
    resolution: 'obsolete',
    reason: 'Fixture reopened.',
    runClosureRetro: false,
  });
  await waitUntil(() => read().closing.complete);
  assert.notEqual(read().closing.id, previousClosure);
  assert.equal(retroRuns, 2);
  assert.equal(read().closing.retro, false);
});

test('automatic closure requires an unrevoked opt-in and a Factory-confirmed Merge', async (t) => {
  const { id, service } = fixture(t);
  const confirmed = { summary: 'Confirmed merge', result: { mergeOrigin: 'factory-confirmed' } };
  let outcome = Promise.resolve(confirmed);
  const flows = createIssueFlows(service, { executor: executor(() => outcome) });
  const closed = [];
  flows.autoClose = async (issueId) => closed.push(issueId);
  const action = async (name, fields) => {
    const { flow } = await flows.view(id);
    return flows.action({ issueId: id, revision: flow.revision, action: name, ...fields });
  };
  const start = () => action('start', { blockId: 'merge' });
  await start();
  await flows.active.get(id)?.task;
  assert.deepEqual(closed, []);

  await action('auto-close-setting', { enabled: true });
  outcome = Promise.resolve({ summary: 'Observed merge', result: { mergeOrigin: 'observed-merged' } });
  await start();
  await flows.active.get(id)?.task;
  assert.deepEqual(closed, []);

  const merge = Promise.withResolvers();
  outcome = merge.promise;
  await start();
  const pending = flows.active.get(id)?.task;
  await action('auto-close-setting', { enabled: false });
  merge.resolve(confirmed);
  await pending;
  assert.deepEqual(closed, []);

  await action('auto-close-setting', { enabled: true });
  await start();
  await flows.active.get(id)?.task;
  assert.deepEqual(closed, [id]);
});

test('Retro reads linked threads in the available provider and reports missing history', async (t) => {
  const { root, id } = fixture(t);
  cpSync(new URL('../.issues/triage-labels.md', import.meta.url), join(root, '.issues/triage-labels.md'));
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const flows = createIssueFlows(service);
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  saveConversationState(root, id, {
    threadId: 'late',
    flowBlocks: {
      work: { threadId: 'early' },
      verify: { threadId: 'missing' },
    },
  });
  let ready = false;
  service.codex.ready = async () => {
    ready = true;
  };
  service.codex.call = async (method, { threadId, includeTurns }) => {
    assert.equal(ready, true);
    assert.equal(method, 'thread/read');
    assert.equal(includeTurns, true);
    if (threadId === 'missing') throw Error('History stored on another runner');
    return { thread: { createdAt: threadId === 'early' ? 1 : 2, turns: [{ items: [] }] } };
  };
  const result = await runRetro(
    service,
    {
      issue,
      flow,
      definition: { prompt: 'Review the issue.' },
      signal: new AbortController().signal,
    },
    () => ({
      async begin() {},
      async ask(input) {
        const history = JSON.parse(input);
        assert.deepEqual(
          history.threads.map(({ id }) => id),
          ['early', 'late', 'missing']
        );
        assert.equal(history.threads[2].unavailable, true);
        return JSON.stringify({ summary: 'Reviewed the available history.', recommendations: [] });
      },
      close() {},
    })
  );
  assert.equal(result.summary, 'Reviewed the available history.');
  assert.equal(flow.workspace, null);
});

test('new investigations expose independent outputs without code delivery or closure blocks', (t) => {
  fixture(t);
  const flow = newFlow(
    { id: '20261113-investigation', title: 'Understand the cache', request_type: 'investigation', content: '' },
    { branch: 'dev', remote: 'origin', base: 'base' }
  );
  assert.deepEqual(
    flow.blocks.map((block) => block.kind),
    ['request', 'investigate', 'generate-report', 'create-issues']
  );
});

test('a disconnected flow keeps classic operations out until its original attempt is reconciled', async (t) => {
  const { root, id, service } = fixture(t);
  const { flowOwnsIssue } = await import('./factory-ui/flow-ownership.mjs');
  const { factoryBoundary } = await import('./factory-ui/issue-operation.mjs');
  const flow = newFlow({ id, title: 'Example', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.blocks.find((block) => block.id === 'work').attempts.push({ id: 'unknown-original-turn', status: 'uncertain' });
  new FlowStore(root).save(flow, 0);
  service.flows = { active: new Map() };
  assert.equal(flowOwnsIssue(service, id), true);
  await assert.rejects(factoryBoundary(service, id), /flow block owns/);
  const scoped = Object.create(service);
  scoped.flowOperationIssueId = id;
  assert.equal(flowOwnsIssue(scoped, id), false);
  assert.equal(flowOwnsIssue(service, id), true);
});

test('a diverged local target cannot hide the configured fetched target change', async (t) => {
  const { root, id, git, service } = fixture(t);
  const original = git('rev-parse', 'HEAD');
  const originalBranch = git('branch', '--show-current');
  writeFileSync(join(root, 'source.txt'), 'local target');
  git('add', 'source.txt');
  git('commit', '-qm', 'local target');
  git('branch', '-f', 'dev', 'HEAD');
  const checkout = join(root, '.issues/work');
  git('worktree', 'add', '-qb', 'codex/target-test', checkout, 'dev');
  git('checkout', '-qb', 'remote-target', original);
  writeFileSync(join(root, 'source.txt'), 'remote target');
  git('add', 'source.txt');
  git('commit', '-qm', 'remote target');
  const remote = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/dev', remote);
  git('checkout', originalBranch);
  const flow = newFlow({ id, title: 'Target test', content: '' }, { branch: 'dev', remote: 'origin' });
  flow.workspace = { checkout, branch: 'codex/target-test', base: git('rev-parse', 'dev') };
  const observed = await createFlowObserver(service).observe(flow);
  assert.equal(observed.targetRevision, remote);
  assert.equal(observed.behind, 1);
  assert.notEqual(observed.localTargetRevision, observed.targetRevision);
});

test('failed continuation retains original ownership until provider idle is positively observed', async (t) => {
  const { root, id, service } = fixture(t);
  const { flowOwnsIssue } = await import('./factory-ui/flow-ownership.mjs');
  const initial = newFlow({ id, title: 'Unknown original turn', content: '' }, { branch: 'dev', remote: 'origin' });
  initial.blocks
    .find((block) => block.id === 'work')
    .attempts.push({ id: 'original', status: 'uncertain', startedAt: new Date().toISOString() });
  new FlowStore(root).save(initial, 0);
  let idle = false;
  const flows = createIssueFlows(service, {
    executor: executor(async ({ onReconciled }) => {
      if (idle) onReconciled();
      throw Error(idle ? 'A later terminal block failure.' : 'The original provider turn is still active.');
    }),
  });
  service.flows = flows;
  await flows.action({ issueId: id, revision: 1, action: 'continue', blockId: 'work' });
  await flows.active.get(id)?.task;
  assert.equal(flowOwnsIssue(service, id), true);
  let view = await flows.view(id);
  await assert.rejects(
    flows.action({ issueId: id, revision: view.flow.revision, action: 'start', blockId: 'merge' }),
    /reconcile/
  );
  idle = true;
  await flows.action({ issueId: id, revision: view.flow.revision, action: 'continue', blockId: 'work' });
  await flows.active.get(id)?.task;
  assert.equal(flowOwnsIssue(service, id), false);
  view = await flows.view(id);
  assert.ok(view.flow.blocks.find((block) => block.id === 'work').attempts[0].reconciledAt);
  assert.equal(view.flow.blocks.find((block) => block.id === 'work').attempts[0].status, 'uncertain');
});

test('opening a changed definition stops active work and invalidates only its connected branch', async (t) => {
  const { root, id, service } = fixture(t);
  let calls = 0;
  const flows = createIssueFlows(service, {
    executor: executor(({ signal }) => {
      calls++;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(Error('Interrupted by edit.')), { once: true })
      );
    }),
  });
  const issue = flows.selected(id);
  const withVerify = editFlow(flows.read(issue), { action: 'add', kind: 'verify', afterId: 'work' });
  const initial = editFlow(withVerify, { action: 'add', kind: 'design', lane: 1 });
  const independent = initial.blocks.find((block) => block.kind === 'design');
  independent.attempts.push({ id: 'independent', status: 'completed', startedAt: new Date().toISOString() });
  const verify = initial.blocks.find((block) => block.kind === 'verify');
  verify.attempts.push({ id: 'proof', status: 'completed', startedAt: new Date().toISOString() });
  flows.store.save(initial, 0);
  await flows.action({ issueId: id, revision: 1, action: 'start', blockId: 'work' });
  const active = flows.active.get(id);
  const path = flows.catalog.createOverride('work');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('Perform the requested work.', 'Perform the requested repair.')
  );
  await flows.action({ issueId: id, action: 'open-block', blockId: verify.id });
  assert.equal(active.controller.signal.aborted, false);
  await flows.action({ issueId: id, action: 'open-block', blockId: 'work' });
  await active.task;
  const { flow } = await flows.view(id);
  const attempt = (blockId) => flow.blocks.find((block) => block.id === blockId).attempts.at(-1);
  assert.equal(attempt('work').status, 'stopped');
  assert.ok(attempt('work').invalidatedAt);
  assert.ok(attempt(verify.id).invalidatedAt);
  assert.equal(attempt(independent.id).invalidatedAt, undefined);
  assert.equal(calls, 1);
});

test('editing Your words invalidates every following block even when clarification criteria match', async (t) => {
  const { id, service } = fixture(t);
  const fields = { type: 'bug', goal: 'Repair Save', requestedProof: 'Reload Save' };
  const flows = createIssueFlows(service, { clarify: async () => ({ artifacts: { values: fields } }) });
  t.after(() => flows.close());
  let view = await flows.view(id);
  view = await flows.action({ action: 'request', issueId: id, revision: view.flow.revision, wording: 'Fix Save' });
  const issue = flows.selected(id);
  const saved = flows.read(issue);
  const independent = makeBlock('advice', []);
  saved.blocks.push(independent);
  for (const block of saved.blocks.filter((block) => block.kind !== 'request'))
    block.attempts.push({
      id: 'previous-' + block.id,
      status: 'completed',
      startedAt: '2026-11-19T12:00:00Z',
      endedAt: '2026-11-19T12:00:01Z',
      output: 'Retained earlier output',
      evidence: [],
    });
  flows.store.save(saved, saved.revision);
  view = await flows.action({
    action: 'request',
    issueId: id,
    revision: flows.read(issue).revision,
    wording: 'Fix Save with the revised requirements',
  });
  for (const block of view.flow.blocks.filter((block) => block.kind !== 'request')) {
    const previous = block.attempts.find((attempt) => attempt.id === 'previous-' + block.id);
    assert.ok(previous?.invalidatedAt, block.id + ' kept stale results');
    assert.equal(previous.output, 'Retained earlier output');
  }
});

test('issue merge status exposes conflicts and Abort merge rejects stale or busy requests', async (t) => {
  const { root, git, id, service } = fixture(t);
  service.guard = () => {};
  const base = git('rev-parse', 'HEAD');
  const checkout = join(root, '.issues/issue-work', id);
  const branch = 'codex/merge-state';
  git('worktree', 'add', '-qb', branch, checkout, base);
  const work = (...args) => git('-C', checkout, ...args);
  writeFileSync(join(root, 'source.txt'), 'Incoming change\n');
  git('commit', '-am', 'Incoming change');
  const target = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'source.txt'), 'Issue change\n');
  work('commit', '-am', 'Issue change');
  const saved = work('rev-parse', 'HEAD');
  assert.throws(() => work('merge', '--no-edit', target));
  const flows = createIssueFlows(service);
  t.after(() => flows.close());
  const issue = flows.selected(id);
  const flow = flows.read(issue);
  flow.workspace = { checkout, branch, base };
  flows.store.save(flow, flow.revision);
  const view = await flows.view(id);
  assert.deepEqual(view.environment.merge, { head: saved, target, conflicts: ['source.txt'] });
  const input = { action: 'abort-merge', issueId: id, revision: view.flow.revision, merge: view.environment.merge };
  await assert.rejects(flows.action({ ...input, merge: { ...input.merge, target: base } }), /merge changed/);
  flows.active.set(id, { controller: new AbortController(), blockId: 'work' });
  await assert.rejects(flows.action(input), /active issue work/);
  flows.active.delete(id);
  const result = await flows.action(input);
  assert.equal(result.environment.merge, null);
  assert.equal(work('rev-parse', 'HEAD'), saved);
  assert.equal(work('status', '--porcelain'), '');
});

function mergedIssueFixture(t, { observed = false } = {}) {
  const f = fixture(t);
  const calls = [];
  const flows = createIssueFlows(f.service, {
    executor: executor(async () => {
      calls.push('execute');
      return {};
    }),
    observer: {
      observe: async () =>
        observed
          ? {
              pr: {
                number: 91,
                url: 'https://github.com/test/fixture/pull/91',
                branch: 'dev',
                mergedAt: '2026-11-20T20:51:58Z',
                head: 'merged-head',
              },
            }
          : {},
    },
  });
  f.service.flows = flows;
  t.after(() => flows.close());
  const flow = flows.read(flows.selected(f.id));
  flow.destination = { branch: 'dev', pr: 91, url: 'https://github.com/test/fixture/pull/91' };
  const merge = flow.blocks.find((block) => block.kind === 'merge');
  if (!observed)
    merge.attempts.push({
      id: 'confirmed-merge',
      status: 'completed',
      startedAt: '2026-11-20T20:38:52Z',
      endedAt: '2026-11-20T20:51:59Z',
      summary: 'GitHub confirms the protected merge.',
      result: { pr: 91, revision: 'merged-revision', head: 'merged-head', url: flow.destination.url },
    });
  const saved = flows.store.save(flow, flow.revision);
  return { ...f, flows, flow: saved, calls };
}

test('merged issue stays read-only after its Merge definition changes without invalidating history', async (t) => {
  const f = mergedIssueFixture(t);
  const merge = f.flow.blocks.find((block) => block.kind === 'merge');
  merge.definitionChecksum = 'earlier-definition';
  f.flow = f.flows.store.save(f.flow, f.flow.revision);
  const before = readFileSync(f.flows.store.path(f.id), 'utf8');
  await f.flows.action({ issueId: f.id, blockId: merge.id, action: 'open-block', revision: f.flow.revision });
  assert.equal(readFileSync(f.flows.store.path(f.id), 'utf8'), before);
  const view = await f.flows.view(f.id);
  assert.equal(view.issue.readOnly, true);
  assert.equal(view.issue.status, 'merged');
  assert.deepEqual(f.calls, []);
});

for (const [label, input] of [
  ['rename', { action: 'rename-issue', title: 'Changed after merge', previousTitle: 'Preserve request wording' }],
  ['request edit', { action: 'edit-request', wording: 'Different work' }],
  ['graph edit', { action: 'add', kind: 'work' }],
  ['flow definition refresh', { action: 'refresh-definition', blockId: 'merge' }],
  ['route start/resume', { action: 'play' }],
  ['Work retry', { action: 'start', blockId: 'work' }],
  ['Merge retry', { action: 'continue', blockId: 'merge' }],
  ['verification settings', { action: 'full-regression-setting', enabled: true }],
]) {
  test(`merged issue rejects ${label} before changing the issue or flow`, async (t) => {
    const f = mergedIssueFixture(t);
    const report = readFileSync(join(f.root, '.issues', f.id + '.md'), 'utf8');
    const flow = readFileSync(f.flows.store.path(f.id), 'utf8');
    await assert.rejects(f.flows.action({ ...input, issueId: f.id, revision: f.flow.revision }), /merged.*read.only/i);
    assert.equal(readFileSync(join(f.root, '.issues', f.id + '.md'), 'utf8'), report);
    assert.equal(readFileSync(f.flows.store.path(f.id), 'utf8'), flow);
    assert.deepEqual(f.calls, []);
  });
}

test('an externally merged PR locks edits before the first merged issue view and remains locked after restart', async (t) => {
  const f = mergedIssueFixture(t, { observed: true });
  await assert.rejects(
    f.flows.action({
      issueId: f.id,
      revision: f.flow.revision,
      action: 'rename-issue',
      title: 'Changed',
      previousTitle: 'Preserve request wording',
    }),
    /merged.*read.only/i
  );
  const after = f.flows.read(f.flows.selected(f.id));
  const restarted = createIssueFlows(f.service, {
    observer: { observe: async () => ({ remoteError: 'GitHub unavailable' }) },
  });
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.action({ issueId: f.id, revision: after.revision, action: 'play' }),
    /merged.*read.only/i
  );
});

test('discovering a definition change on another issue preserves merged history', async (t) => {
  const f = mergedIssueFixture(t);
  const merge = f.flow.blocks.find((block) => block.kind === 'merge');
  merge.definitionChecksum = 'earlier-definition';
  merge.attempts[0].invalidatedAt = '2026-11-20T22:36:01Z';
  f.flows.store.save(f.flow, f.flow.revision);
  const before = readFileSync(f.flows.store.path(f.id), 'utf8');
  const otherId = '20261121-another-issue';
  writeFileSync(
    join(f.root, '.issues', otherId + '.md'),
    `---\nid: ${otherId}\ntitle: Different issue\nstate: backlog\ncreated: 2026-11-21T00:00:00Z\n---\n\n## Original request\n\nUnmerged work.\n`
  );
  const other = f.flows.read(f.flows.selected(otherId));
  other.blocks.find((block) => block.kind === 'merge').definitionChecksum = 'earlier-definition';
  const saved = f.flows.store.save(other, other.revision);
  await f.flows.action({ issueId: otherId, action: 'open-block', blockId: 'merge', revision: saved.revision });
  assert.equal(readFileSync(f.flows.store.path(f.id), 'utf8'), before);
  assert.equal((await f.flows.view(f.id)).issue.readOnly, true);
});

test('opening an externally merged issue records its delivery before checking definitions', async (t) => {
  const f = mergedIssueFixture(t, { observed: true });
  const merge = f.flow.blocks.find((block) => block.kind === 'merge');
  merge.definitionChecksum = 'earlier-definition';
  const saved = f.flows.store.save(f.flow, f.flow.revision);
  await f.flows.action({ issueId: f.id, action: 'open-block', blockId: merge.id, revision: saved.revision });
  const after = f.flows.read(f.flows.selected(f.id));
  assert.deepEqual(after.blocks, saved.blocks);
  assert.equal(after.merged.pr, 91);
  assert.deepEqual(f.calls, []);
});

test('an unmerged PR can still be edited and local files need no remote observer', async (t) => {
  const f = mergedIssueFixture(t, { observed: true });
  f.flows.observer = { observe: async () => ({ pr: { number: 91, mergedAt: null } }) };
  await f.flows.action({
    issueId: f.id,
    revision: f.flow.revision,
    action: 'rename-issue',
    previousTitle: 'Preserve request wording',
    title: 'Still editable',
  });
  assert.equal(f.flows.selected(f.id).title, 'Still editable');
  const saved = f.flows.read(f.flows.selected(f.id));
  delete saved.destination.pr;
  f.flows.store.save(saved, saved.revision);
  f.flows.observer = {
    observe: async () => {
      throw Error('Local issue should not query GitHub');
    },
  };
  await f.flows.requireEditableIssue(f.id);
});

test('editing a linked PR refreshes its cached open status before a newly observed merge', async (t) => {
  const f = fixture(t);
  const repository = 'test/fixture';
  const config = { provider: 'github', repository, remote: 'origin', target: 'dev' };
  writeFileSync(join(f.root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  let merged = false;
  let reads = 0;
  const observer = createFlowObserver(f.service, {
    provider: {
      config,
      async inspect() {
        reads++;
        return {
          number: 91,
          html_url: 'https://github.com/test/fixture/pull/91',
          head: { sha: 'original-head', repo: { full_name: repository } },
          base: { ref: 'dev', repo: { full_name: repository } },
          merged_at: merged ? '2026-11-20T20:51:58Z' : null,
          merge_commit_sha: merged ? 'confirmed-merge' : null,
        };
      },
    },
  });
  const flows = createIssueFlows(f.service, { observer });
  t.after(() => flows.close());
  const flow = flows.read(flows.selected(f.id));
  flow.destination = { branch: 'dev', pr: 91 };
  const saved = flows.store.save(flow, flow.revision);
  assert.equal((await observer.observe(saved, { refresh: true })).pr.mergedAt, null);
  merged = true;
  assert.equal((await observer.observe(saved)).pr.mergedAt, null);
  assert.equal(reads, 1);
  await assert.rejects(
    flows.action({
      issueId: f.id,
      revision: saved.revision,
      action: 'rename-issue',
      title: 'Changed',
      previousTitle: 'Preserve request wording',
    }),
    /merged.*read.only/i
  );
  assert.equal(reads, 2);
  assert.equal(flows.read(flows.selected(f.id)).merged.revision, 'confirmed-merge');
});

test('an unavailable linked PR status refuses edits without changing the saved issue or flow', async (t) => {
  const f = mergedIssueFixture(t, { observed: true });
  f.flows.observer = { observe: async () => ({ remoteError: 'GitHub unavailable' }) };
  const before = readFileSync(f.flows.store.path(f.id), 'utf8');
  await assert.rejects(
    f.flows.action({
      issueId: f.id,
      revision: f.flow.revision,
      action: 'rename-issue',
      title: 'Changed',
      previousTitle: 'Preserve request wording',
    }),
    /Cannot confirm whether this PR merged/
  );
  assert.equal(readFileSync(f.flows.store.path(f.id), 'utf8'), before);
  assert.equal(f.flows.selected(f.id).title, 'Preserve request wording');
});

test('a shared claim timeout retains the block failure and completed verification', async (t) => {
  const { id, service } = fixture(t);
  const verification = { head: 'retained-candidate', proof: [{ path: 'retained-proof' }] };
  service.sharedIssues = {
    acquireFlowBlock: () => ({ issueId: id, oid: 'original-claim' }),
    releaseFlowBlock() {
      throw Object.assign(Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    },
    view() {},
  };
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Object.assign(Error('Original GitHub request failed'), { deliveryVerification: verification });
    }),
  });
  t.after(() => flows.close());
  await flows.action({ issueId: id, revision: 0, blockId: 'work', action: 'start' });
  await flows.active.get(id)?.task;
  const attempt = flows
    .read(flows.selected(id))
    .blocks.find((block) => block.id === 'work')
    .attempts.at(-1);
  assert.equal(attempt.status, 'uncertain');
  assert.match(attempt.summary, /Original GitHub request failed/);
  assert.match(attempt.summary, /claim release.*spawnSync git ETIMEDOUT/i);
  assert.deepEqual(attempt.result.verification, verification);
  assert.deepEqual(attempt.claimReleaseFailure, {
    status: 'blocked',
    summary: 'Original GitHub request failed',
    message: 'spawnSync git ETIMEDOUT',
  });
});
