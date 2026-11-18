import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProjectDiscussTools } from './factory-ui/project-discuss-tools.mjs';
import { gitFixture } from './git-fixture.mjs';
import { listAvailableSkills } from './factory-ui/skills.mjs';

function fixture(t) {
  const { root } = gitFixture(t, 'project-tool-');
  mkdirSync(join(root, '.issues/closed'), { recursive: true });
  writeFileSync(join(root, '.issues/triage-labels.md'), '| role | state |\n| closed | closed |\n');
  const calls = [];
  const service = {
    root,
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    issueCleanupTasks: new Map(),
    store: { runs: [], connected: new Set() },
    ownServer() {
      calls.push('owner');
    },
    serverControl: {
      allow(path, input) {
        calls.push({ path, input });
      },
    },
  };
  const home = {
    async view() {
      return { branches: [{ ref: 'dev' }], investigations: [] };
    },
    async action(input) {
      calls.push(input);
      return { issueId: '20261118-test' };
    },
  };
  const flows = {
    async action(input) {
      calls.push(input);
      return { issue: { id: input.issueId }, conversation: ['Must not leak into project chat'], flow: { blocks: [] } };
    },
    async capture(input) {
      calls.push(input);
      return { issue: { id: '20261118-test' } };
    },
  };
  const tools = createProjectDiscussTools(service, { home: () => home, flows: () => flows });
  return { root, calls, service, tools, home, flows };
}

test('registry exposes callable Home operations and delegates commands to existing controls without issue transcripts', async (t) => {
  const f = fixture(t);
  assert.equal(new Set(f.tools.definitions.map(({ name }) => name)).size, f.tools.definitions.length);
  for (const definition of f.tools.definitions) assert.equal(definition.inputSchema.type, 'object');
  const result = await f.tools.invoke('issue_control', { action: 'play', issueId: '20261118-test', revision: 2 });
  assert.deepEqual(result, {
    action: 'play',
    status: 'accepted',
    issueId: '20261118-test',
    url: '/?issue=20261118-test',
  });
  assert.ok(!JSON.stringify(result).includes('Must not leak'));
  assert.equal(f.calls.filter((call) => call?.action === 'play').length, 1);
  assert.equal(f.calls.find((call) => call?.path).path, '/api/flow-action');
  const home = await f.tools.invoke('project_home', {});
  assert.equal(home.branches[0].ref, 'dev');
  await f.tools.invoke('project_investigation', {
    action: 'investigation-create',
    requestId: 'capture-1',
    focus: 'Architecture',
    branch: 'dev',
  });
  assert.equal(f.calls.filter((call) => call?.action === 'investigation-create').length, 1);
});

test('invalid names, arguments, previews and paused new work are refused before dispatch', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.tools.invoke('unknown', {}), /registered project tool/);
  await assert.rejects(() => f.tools.invoke('issue_control', { action: 'arbitrary-shell', issueId: 'x', revision: 1 }));
  await assert.rejects(() => f.tools.invoke('issue_control', { action: 'play', issueId: '../outside', revision: 1 }));
  await assert.rejects(() => f.tools.invoke('project_home', { prompt: 'unexpected' }));
  assert.deepEqual(f.calls, []);
  f.service.reviewMode = 'preview';
  await assert.rejects(() => f.tools.invoke('issue_create', { description: 'Test issue' }), /preview/);
  f.service.reviewMode = 'live';
  f.service.serverControl.allow = () => {
    throw Error('No new actions');
  };
  await assert.rejects(
    () => f.tools.invoke('issue_control', { action: 'play', issueId: 'test', revision: 1 }),
    /No new actions/
  );
  const stopped = await f.tools.invoke('issue_control', {
    action: 'stop',
    issueId: 'test',
    revision: 1,
    blockId: 'work',
  });
  assert.equal(stopped.action, 'stop');
});

test('explicit closed-issue query and archive use the real storage controls in a disposable project', async (t) => {
  const f = fixture(t);
  const id = '20261118-closed';
  const content = `---\nid: ${id}\ntitle: Retained closed issue\nstate: closed\n---\n\nPreserve this report.\n`;
  writeFileSync(join(f.root, '.issues/closed', id + '.md'), content);
  const list = await f.tools.invoke('issues_list', { location: 'closed' });
  assert.deepEqual(
    list.issues.map((issue) => issue.id),
    [id]
  );
  const result = await f.tools.invoke('issue_archive', { action: 'archive', issueIds: [id] });
  assert.equal(result.results[0].status, 'archived');
  assert.equal(existsSync(join(f.root, '.issues/closed', id + '.md')), false);
  assert.match(readFileSync(join(f.root, '.issues/archive', id + '.md'), 'utf8'), /Preserve this report/);
  assert.equal((await f.tools.invoke('issues_list', { location: 'closed' })).issues.length, 0);
});

test('local reusable skills are discoverable and implicit restrictions come from authoritative skill metadata', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'user/skills/test/');
  mkdirSync(join(path, 'agents'), { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), '---\nname: test\ndescription: Test skill\n---\n\nUse the registered tool.\n');
  writeFileSync(
    join(path, 'agents/openai.yaml'),
    'interface:\n  display_name: Test Display\npolicy:\n  allow_implicit_invocation: false\n'
  );
  const connection = {
    async ready() {},
    async call() {
      return { data: [] };
    },
  };
  const skills = await listAvailableSkills(connection, f.root);
  const selected = skills.find((skill) => skill.name === 'test');
  assert.equal(selected.source, 'Project');
  assert.equal(selected.displayName, 'Test Display');
  assert.equal(selected.allowImplicitInvocation, false);
});

test('factory archive skill is discoverable separately from user skills', async (t) => {
  const f = fixture(t);
  const skills = await listAvailableSkills({ ready: async () => {}, call: async () => ({ data: [] }) }, f.root);
  const archive = skills.find((skill) => skill.name === 'archive');
  assert.equal(archive.source, 'Factory');
  assert.equal(archive.allowImplicitInvocation, true);
  assert.match(archive.path, /factory\/system\/skills\/archive\/SKILL\.md$/);
  assert.equal(existsSync(join(f.root, 'user/skills/archive')), false);
});

function numberedReports(f, numbers) {
  const registry = {};
  for (const number of numbers) {
    const issueId = '20261118-archive-' + number;
    registry[issueId] = number;
    writeFileSync(
      join(f.root, '.issues/closed', issueId + '.md'),
      `---\nid: ${issueId}\ntitle: Archive ${number}\nstate: closed\n---\n\nRetain report ${number}.\n`
    );
  }
  writeFileSync(
    join(f.root, '.issues/issue-numbers.json'),
    JSON.stringify({ version: 1, next: Math.max(...numbers) + 1, issues: registry })
  );
  return registry;
}

test('archive accepts a deduplicated number list in one guarded batch and safely repeats', async (t) => {
  const f = fixture(t);
  const registry = numberedReports(f, [11, 12, 13]);
  const result = await f.tools.invoke('issue_archive', { action: 'archive', issueNumbers: [11, 12, 11, 13] });
  assert.deepEqual(
    result.results.map(({ issueNumber, status }) => [issueNumber, status]),
    [
      [11, 'archived'],
      [12, 'archived'],
      [13, 'archived'],
    ]
  );
  assert.equal(f.calls.filter((call) => call?.path === '/api/issue-storage-move').length, 1);
  for (const [issueId, number] of Object.entries(registry)) {
    assert.equal(existsSync(join(f.root, '.issues/closed', issueId + '.md')), false);
    assert.match(
      readFileSync(join(f.root, '.issues/archive', issueId + '.md'), 'utf8'),
      new RegExp('Retain report ' + number)
    );
  }
  const repeat = await f.tools.invoke('issue_archive', { action: 'archive', issueNumbers: [11, 12, 13] });
  assert.ok(repeat.results.every((item) => item.alreadyArchived));
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.issues/issue-numbers.json'))).issues, registry);
});

test('unknown numbers fail before any archive; active items retain per-issue failure without losing other results', async (t) => {
  const f = fixture(t);
  const registry = numberedReports(f, [21, 22]);
  await assert.rejects(() => f.tools.invoke('issue_archive', { action: 'archive', issueNumbers: [21, 999] }), /#999/);
  assert.ok(Object.keys(registry).every((issueId) => existsSync(join(f.root, '.issues/closed', issueId + '.md'))));
  const activeId = Object.keys(registry).find((issueId) => registry[issueId] === 22);
  f.service.lifecycleTasks.set(activeId, {});
  const result = await f.tools.invoke('issue_archive', { action: 'archive', issueNumbers: [21, 22] });
  assert.deepEqual(
    result.results.map(({ status }) => status),
    ['archived', 'failed']
  );
  assert.equal(result.results[1].issueNumber, 22);
  assert.equal(existsSync(join(f.root, '.issues/closed', activeId + '.md')), true);
  await assert.rejects(() =>
    f.tools.invoke('issue_archive', { action: 'archive', issueNumbers: [21], issueIds: [activeId] })
  );
});
