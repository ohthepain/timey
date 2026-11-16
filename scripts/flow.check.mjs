import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFixture } from './git-fixture.mjs';
import { deliveryTarget, requestData, startingPoint } from './factory-ui/flow-block-data.mjs';
import { FlowStore, newFlow, editFlow } from './factory-ui/flow-store.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createFlowObserver } from './factory-ui/flow-observer.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { humanGuard } from './factory-ui/guard.mjs';
import { ViewSources } from './factory-ui/view-sources.mjs';
import { BlockCatalog, blockExtensions, userBlocks } from './factory-ui/block-catalog.mjs';

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
  assert.equal(saved.blocks.find((block) => block.kind === 'work').skill, null);
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
  assert.equal(saved.blocks.find((block) => block.kind === 'work').skill, null);
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
  assert.equal(work.content.extensionPath, 'factory/ui/extensions/flow/blocks/work.md');
  const workOverride = readFileSync(workPath, 'utf8');
  const checksumForDeclaration = (declaration) => {
    writeFileSync(workPath, workOverride + '\n# User extensions\n\n`' + declaration + '`\n');
    return catalog.read().entries.find((entry) => entry.id === 'work').checksum;
  };
  assert.equal(checksumForDeclaration('factory/ui/extensions/flow/blocks/work.md'), checksumForDeclaration('work.md'));
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

test('issue Play continues after confirmation and Pause lets the active block finish', async (t) => {
  const { id, service } = fixture(t);
  const started = [];
  const work = Promise.withResolvers();
  const flows = createIssueFlows(service, {
    clarify: async () => ({ artifacts: { values: { type: 'bug', goal: 'Repair Save' } } }),
    executor: executor(async ({ block, signal }) => {
      started.push(block.kind);
      if (block.kind === 'work') await work.promise;
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
  await action('add', { kind: 'merge-target', afterId: pending('verify').id });
  await action('play');
  assert.deepEqual(started, ['work']);
  assert.equal(pending('request').attempts.at(-1).status, 'completed');
  await action('pause');
  const running = flows.active.get(id).task;
  work.resolve();
  await running;
  assert.deepEqual(started, ['work']);
  await action('play');
  const sync = pending('merge-target');
  assert.deepEqual((await view()).autoplay, { mode: 'waiting', blockId: sync.id });
  assert.deepEqual(started, ['work', 'verify']);
  await action('cancel-confirmation', { blockId: sync.id });
  assert.equal((await view()).autoplay.mode, 'paused');
  await action('play');
  await action('start', { blockId: sync.id, confirmed: true });
  await flows.active.get(id)?.task;
  assert.deepEqual(started, ['work', 'verify', 'merge-target']);
  assert.deepEqual((await view()).autoplay, { mode: 'waiting', blockId: pending('publish').id });
  for (const kind of ['publish', 'merge', 'close']) await action('remove', { blockId: pending(kind).id });
  assert.equal((await view()).autoplay.mode, 'paused');
  await action('play');
  assert.deepEqual((await view()).autoplay, { mode: 'paused', reason: 'Flow complete' });
});

test('issue Play pauses on failure and Stop, retries once, and does not recover after restart', async (t) => {
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

test('the issue pencil saves one title and Request edits keep verification when the criteria match', async (t) => {
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
  assert.equal(currentVerify().invalidatedAt, undefined);
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

test('request data and block order persist with revision conflicts rejected', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, { executor: executor(async () => ({ summary: 'done' })) });
  let view = await flows.view(id);
  assert.match(requestData(view.flow).wording, /Saved value persists after reload/);
  assert.equal(view.flow.routeType, 'bug');
  const request = view.flow.blocks[0].id;
  assert.equal((await flows.view(id)).flow.blocks[0].id, request);
  view = await flows.action({ issueId: id, revision: 0, action: 'add', kind: 'repro' });
  assert.equal(view.flow.blocks[2].kind, 'repro');
  assert.equal(view.flow.blocks[3].kind, 'publish');
  await assert.rejects(flows.action({ issueId: id, revision: 0, action: 'folder', folder: 'Stale' }), /flow changed/);
  const reloaded = createIssueFlows(service, { executor: executor(async () => ({})) });
  assert.equal((await reloaded.view(id)).flow.blocks[2].kind, 'repro');
  assert.ok(existsSync(join(root, '.issues/flows', id, 'flow.json')));
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
  const observed = await observer.observe(flow);
  assert.equal(observed.behind, 1);
  assert.equal(observed.targetRevision, git('rev-parse', 'dev'));
  const flows = createIssueFlows(service, {
    executor: executor(async () => {
      throw Error('must not execute');
    }),
  });
  const view = await flows.view(id);
  assert.equal(view.flow.blocks.filter((b) => b.kind === 'merge-target').length, 1);
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
    blockId: view.flow.blocks.find((block) => block.kind === 'understand').id,
    text: 'Keep the original wording.',
  });
  assert.equal(view.flow.blocks.find((item) => item.kind === 'understand').comments.length, 1);
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

test('project defaults append, builders run once, and Markdown changes apply only on request', async (t) => {
  const { root, service } = fixture(t);
  const extensionDir = join(root, 'factory/ui/extensions/flow');
  mkdirSync(join(extensionDir, 'definitions'), { recursive: true });
  const promptPath = join(extensionDir, 'definitions/delivery.md');
  writeFileSync(promptPath, 'Start with the **review** block.\n');
  const customDir = join(root, 'factory/ui/flows');
  mkdirSync(customDir);
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
  const directory = join(root, 'factory/ui/flows');
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'team'));
  writeFileSync(
    join(directory, 'review.md'),
    `---
name: Team review
issueTypes: [bug]
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
  assert.equal(exported.flowDefinitions.updated, false);
  const body = readFileSync(join(root, 'factory/ui/flows/with-advice.md'), 'utf8');
  assert.match(body, /block: advice/);
  assert.doesNotMatch(body, /progress|skill:|Build prompt/);
  assert.equal(exported.flow.blocks.find((block) => block.kind === 'work').attempts[0].status, 'completed');
  assert.deepEqual(
    exported.flow.blocks.map((block) => block.id),
    before.flow.blocks.map((block) => block.id)
  );
  const altered = await act(exported, 'add', { kind: 'retro', afterId: 'work' });
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
  assert.equal(existsSync(join(root, 'factory/ui/flows/unlinked.md')), false);
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

test('completed target merges do not hide a later target change and parallel lanes join before publication', async (t) => {
  const { root, id, service } = fixture(t);
  const flows = createIssueFlows(service, {
    executor: executor(async () => ({})),
    observer: {
      async observe() {
        return { behind: 1, targetRevision: 'new-target', observedAt: new Date().toISOString() };
      },
    },
  });
  let flow = flows.read(flows.selected(id));
  flow = editFlow(flow, { action: 'add', kind: 'merge-target' });
  flow.blocks
    .find((block) => block.kind === 'merge-target')
    .attempts.push({ id: 'old', status: 'completed', result: { target: 'old-target' } });
  new FlowStore(root).save(flow, 0);
  assert.ok((await flows.view(id)).flow.blocks.some((block) => block.id === 'target-new-target'));
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

test('new investigations propose understanding and acceptance without code delivery blocks', (t) => {
  fixture(t);
  const flow = newFlow(
    { id: '20261113-investigation', title: 'Understand the cache', request_type: 'investigation', content: '' },
    { branch: 'dev', remote: 'origin', base: 'base' }
  );
  assert.deepEqual(
    flow.blocks.map((block) => block.kind),
    ['request', 'understand', 'close']
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
