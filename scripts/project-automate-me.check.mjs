import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAutomateMe } from './factory-ui/project-automate-me.mjs';
import { automateHistoryWindow, collectAutomateHistory } from './factory-ui/project-automate-history.mjs';
import { AutomateProvider } from './factory-ui/project-automate-provider.mjs';

const now = new Date('2026-11-18T12:00:00.000Z');
const content = (body = 'Use short paragraphs.') =>
  `---\nname: paul-mode\ndescription: Work in the user's style.\ndisable-model-invocation: true\n---\n\n${body}\n`;

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timey-automate-')));
  const personalRoot = join(root, 'personal');
  mkdirSync(personalRoot);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'factory.config.json'), '{}\n');
  const calls = [];
  let output = { message: 'Which conventions matter most?', draft: null };
  const provider = {
    async turn(session, input) {
      calls.push({ session: structuredClone(session), input: { ...input, context: structuredClone(input.context) } });
      return output;
    },
    close() {},
    async stop() {},
  };
  const service = { root, ownServer() {} };
  const engine = new ProjectAutomateMe(service, {
    personalRoot,
    now: () => now,
    history: async (_service, window) => ({
      messages: [{ role: 'user', text: 'Use short paragraphs.', at: now.toISOString() }],
      coverage: {
        ...window,
        messageCount: 1,
        threadCount: 1,
        gaps: ['Only this runner history is available.'],
        truncated: false,
      },
    }),
    providerFactory: () => provider,
    ...options,
  });
  t.after(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    personalRoot,
    engine,
    service,
    calls,
    provider,
    setOutput(value) {
      output = value;
    },
  };
}

async function settled(engine, id) {
  const active = engine.active.get(id);
  if (active) await active.task;
  return engine.view().sessions.find((item) => item.id === id);
}

async function drafted(fixture, id = 'draft-one') {
  fixture.setOutput({ message: 'Here is a draft for review.', draft: { name: 'paul-mode', content: content() } });
  await fixture.engine.action({ action: 'automate-start', requestId: id });
  return settled(fixture.engine, id);
}

function applyInput(session, overrides = {}) {
  const { name, content: text, destination, basis } = session.draft;
  return {
    action: 'automate-apply',
    id: session.id,
    name,
    content: text,
    destination,
    basis,
    activate: false,
    ...overrides,
  };
}

test('history defaults to four weeks and supports a specified duration and unit', () => {
  assert.equal(automateHistoryWindow(undefined, undefined, now).since, '2026-10-21T12:00:00.000Z');
  assert.equal(automateHistoryWindow(10, 'days', now).since, '2026-11-08T12:00:00.000Z');
  assert.equal(automateHistoryWindow(2, 'months', now).since, '2026-09-18T12:00:00.000Z');
  assert.throws(() => automateHistoryWindow(0, 'weeks', now), /duration/);
  assert.throws(() => automateHistoryWindow(4, 'years', now), /days, weeks, or months/);
});

test('view creates no provider runs; starting and replaying a request preserves one interview', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.engine.view(), { sessions: [] });
  assert.equal(f.calls.length, 0);
  const first = await f.engine.action({ action: 'automate-start', requestId: 'first' });
  assert.equal(first.session.durationValue, 4);
  const session = await settled(f.engine, 'first');
  assert.equal(session.status, 'awaiting-input');
  assert.equal(session.history.messageCount, 1);
  assert.equal(session.messages.at(-1).text, 'Which conventions matter most?');
  await f.engine.action({ action: 'automate-start', requestId: 'first' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.view().sessions.length, 1);
  await assert.rejects(
    f.engine.action({ action: 'automate-start', requestId: 'first', durationValue: 2 }),
    /different settings/
  );
  assert.equal(existsSync(join(f.root, '.agents/skills/paul-mode/SKILL.md')), false);
});

test('specified duration reaches history and replies continue the retained conversation', async (t) => {
  const f = fixture(t);
  await f.engine.action({ action: 'automate-start', requestId: 'custom', durationValue: 9, durationUnit: 'days' });
  await settled(f.engine, 'custom');
  assert.equal(f.calls[0].input.context.duration.since, '2026-11-09T12:00:00.000Z');
  f.setOutput({ message: 'I will capture that preference.', draft: { name: 'paul-mode', content: content() } });
  await f.engine.action({ action: 'automate-message', id: 'custom', message: 'Capture my writing style.' });
  const session = await settled(f.engine, 'custom');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].input.context.conversation.at(-1).text, 'Capture my writing style.');
  assert.equal(session.status, 'ready');
  assert.equal(session.draft.currentContent, null);
  assert.equal(session.draft.path, join(f.root, '.agents/skills/paul-mode/SKILL.md'));
  assert.equal(existsSync(session.draft.path), false);
});

test('only an exact reviewed draft is applied, and replay saves no second change', async (t) => {
  const f = fixture(t);
  const session = await drafted(f);
  await assert.rejects(
    f.engine.action(applyInput(session, { content: content('Changed after preview.') })),
    /draft changed/
  );
  await assert.rejects(f.engine.action(applyInput(session, { destination: 'personal' })), /draft changed/);
  await assert.rejects(f.engine.action(applyInput(session, { basis: 'wrong' })), /Preview/);
  const result = await f.engine.action(applyInput(session));
  assert.equal(result.session.status, 'applied');
  assert.equal(result.session.applied.activated, false);
  assert.equal(readFileSync(session.draft.path, 'utf8'), content());
  await f.engine.action(applyInput(session));
  assert.equal(readFileSync(session.draft.path, 'utf8'), content());
});

test('editing an existing mode requires a fresh review after an external change', async (t) => {
  const f = fixture(t);
  const folder = join(f.root, '.agents/skills/paul-mode');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), content('Original.'));
  const session = await drafted(f);
  assert.equal(session.draft.currentContent, content('Original.'));
  writeFileSync(session.draft.path, content('Changed elsewhere.'));
  await assert.rejects(f.engine.action(applyInput(session)), /existing skill changed/);
  const preview = await f.engine.action({
    action: 'automate-preview',
    id: session.id,
    name: 'paul-mode',
    content: content(),
    destination: 'project',
  });
  assert.equal(preview.session.draft.currentContent, content('Changed elsewhere.'));
  await f.engine.action(applyInput(preview.session));
  assert.equal(readFileSync(session.draft.path, 'utf8'), content());
});

test('personal storage is reviewed separately and does not change project defaults without activation', async (t) => {
  const f = fixture(t);
  const session = await drafted(f);
  const preview = await f.engine.action({
    action: 'automate-preview',
    id: session.id,
    name: 'paul-mode',
    content: content(),
    destination: 'personal',
  });
  assert.equal(preview.session.draft.path, join(f.personalRoot, 'skills/paul-mode/SKILL.md'));
  await f.engine.action(applyInput(preview.session));
  assert.equal(readFileSync(preview.session.draft.path, 'utf8'), content());
  assert.equal(existsSync(join(f.root, 'folder.md')), false);
});

test('explicit project activation selects the saved skill for future project work', async (t) => {
  const f = fixture(t);
  const session = await drafted(f);
  const result = await f.engine.action(applyInput(session, { activate: true }));
  assert.equal(result.session.applied.activated, true);
  assert.equal(result.session.applied.activationScope, 'Project default for future work');
  assert.match(readFileSync(join(f.root, 'folder.md'), 'utf8'), /skill: ['"]?paul-mode/);
});

test('skill destinations reject symlink escapes, invalid names, bundled modes and malformed drafts', async (t) => {
  const f = fixture(t);
  const session = await drafted(f);
  const preview = (name, text = content()) =>
    f.engine.action({ action: 'automate-preview', id: session.id, name, content: text, destination: 'project' });
  await assert.rejects(preview('../escape-mode'), /lowercase/);
  await assert.rejects(preview('poteto-mode', content().replace('paul-mode', 'poteto-mode')), /bundled/);
  await assert.rejects(preview('paul-mode', 'No frontmatter'), /frontmatter/);
  await assert.rejects(preview('paul-mode', content().replace('true', 'false')), /disable-model-invocation/);
  mkdirSync(join(f.root, '.agents'), { recursive: true });
  symlinkSync(f.personalRoot, join(f.root, '.agents/skills'));
  await assert.rejects(preview('paul-mode'), /without symlinks/);
  assert.equal(existsSync(join(f.personalRoot, 'paul-mode/SKILL.md')), false);
});

test('a foreign apply lock is retained rather than removed by an unsuccessful attempt', async (t) => {
  const f = fixture(t);
  const session = await drafted(f);
  const lock = join(f.root, '.agents/skills/paul-mode/.timey-apply.lock');
  mkdirSync(lock, { recursive: true });
  await assert.rejects(f.engine.action(applyInput(session)), /EEXIST/);
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(session.draft.path), false);
});

test('failures retain the interview and only explicit retry starts another turn', async (t) => {
  const f = fixture(t);
  f.provider.turn = async () => {
    throw Error('Provider unavailable.');
  };
  await f.engine.action({ action: 'automate-start', requestId: 'failed' });
  let session = await settled(f.engine, 'failed');
  assert.equal(session.status, 'failed');
  assert.match(session.error, /Provider unavailable/);
  f.provider.turn = async () => ({ message: 'What changed?', draft: null });
  const resumed = new ProjectAutomateMe(f.service, {
    personalRoot: f.personalRoot,
    now: () => now,
    providerFactory: () => f.provider,
  });
  t.after(() => resumed.close());
  assert.equal(resumed.view().sessions[0].status, 'failed');
  await resumed.action({ action: 'automate-retry', id: 'failed' });
  session = await settled(resumed, 'failed');
  assert.equal(session.status, 'awaiting-input');
});

test('Stop preserves progress and restart never resumes an interrupted session', async (t) => {
  let release;
  const f = fixture(t, {
    providerFactory: () => ({
      turn: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      async stop() {
        release({ message: 'Late result', draft: null });
      },
      close() {},
    }),
  });
  await f.engine.action({ action: 'automate-start', requestId: 'stop' });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await f.engine.action({ action: 'automate-stop', id: 'stop' });
  const stopped = await settled(f.engine, 'stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(
    stopped.messages.some((item) => item.text === 'Late result'),
    false
  );
  const statePath = join(f.root, '.issues/factory-ui/project-automate-me/stop.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.status = 'running';
  writeFileSync(statePath, JSON.stringify(state));
  const resumed = new ProjectAutomateMe(f.service, { personalRoot: f.personalRoot, now: () => now });
  t.after(() => resumed.close());
  assert.equal(resumed.view().sessions[0].status, 'stopped');
  assert.equal(resumed.active.size, 0);
});

test('history retains only in-window messages and excludes foreign native projects', async (t) => {
  const f = fixture(t);
  const foreign = mkdtempSync(join(tmpdir(), 'timey-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', foreign]);
  const conversation = join(f.root, '.issues/conversations/issue-one');
  mkdirSync(conversation, { recursive: true });
  writeFileSync(
    join(conversation, 'messages.jsonl'),
    [
      { id: 'new', at: '2026-11-17T10:00:00.000Z', kind: 'user', body: 'Use short paragraphs.' },
      { id: 'old', at: '2025-11-17T10:00:00.000Z', kind: 'user', body: 'Old preference' },
      { id: 'untimed', kind: 'user', body: 'No date' },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n')
  );
  let foreignRead = false;
  const service = {
    ...f.service,
    codex: {
      async ready() {},
      async call(method, input) {
        if (method === 'thread/list')
          return {
            data: [
              { id: 'local', cwd: f.root },
              { id: 'foreign', cwd: foreign },
            ],
          };
        if (input.threadId === 'foreign') foreignRead = true;
        return {
          thread: {
            cwd: f.root,
            turns: [
              {
                id: 'turn',
                startedAt: Date.parse('2026-11-17T11:00:00Z') / 1000,
                items: [
                  { id: 'message', type: 'userMessage', content: [{ type: 'text', text: 'Use focused tests.' }] },
                ],
              },
            ],
          },
        };
      },
    },
  };
  const history = await collectAutomateHistory(
    service,
    automateHistoryWindow(4, 'weeks', now),
    new AbortController().signal
  );
  assert.deepEqual(
    history.messages.map((item) => item.text),
    ['Use short paragraphs.', 'Use focused tests.']
  );
  assert.equal(foreignRead, false);
  assert.ok(history.coverage.gaps.some((item) => item.includes('timestamp')));
});

test('provider uses the actual native automate-me skill with project model and a read-only Codex adapter', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'automate-me-SKILL.md');
  writeFileSync(path, '# Automate me\n');
  const calls = [];
  const connection = {
    async ready() {},
    async call(method, input) {
      calls.push({ method, input });
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'automate-me', path, enabled: true }] }] };
      return { thread: { id: 'native', status: { type: 'idle' } } };
    },
    async turn(...args) {
      calls.push({ method: 'turn', args });
      return JSON.stringify({ message: 'Which habits?', draft: null });
    },
    close() {},
  };
  const provider = new AutomateProvider(f.service, connection);
  const session = {};
  await provider.turn(session, {
    signal: new AbortController().signal,
    context: { history: [] },
    retain(values) {
      Object.assign(session, values);
    },
  });
  const start = calls.find((item) => item.method === 'thread/start').input;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config['features.shell_tool'], false);
  assert.match(start.developerInstructions, /Cursor-specific mechanics/);
  assert.match(start.developerInstructions, /No filesystem edits/);
  const turn = calls.find((item) => item.method === 'turn');
  assert.deepEqual(turn.args[4], [{ type: 'skill', name: 'automate-me', path }]);
  assert.equal(turn.args[5].model, start.model);
  assert.equal(turn.args[5].effort, 'medium');
  await provider.turn(session, {
    signal: new AbortController().signal,
    context: {},
    retain(values) {
      Object.assign(session, values);
    },
  });
  assert.equal(calls.filter((item) => item.method === 'thread/start').length, 1);
  assert.equal(calls.filter((item) => item.method === 'thread/resume').length, 1);
});

test('a reply with a stable request ID is acknowledged once even while its response is running', async (t) => {
  const f = fixture(t);
  await f.engine.action({ action: 'automate-start', requestId: 'reply-session' });
  await settled(f.engine, 'reply-session');
  let release;
  let turns = 0;
  f.provider.turn = async () => {
    turns++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const input = {
    action: 'automate-message',
    id: 'reply-session',
    requestId: 'stable-reply',
    message: 'Use focused tests.',
  };
  await f.engine.action(input);
  await f.engine.action(input);
  assert.equal(turns, 1);
  await assert.rejects(f.engine.action({ ...input, message: 'Different text' }), /different text/);
  await assert.rejects(f.engine.action({ ...input, requestId: 'another-reply' }), /current Automate me response/);
  assert.equal(f.engine.activeCount, 1);
  release({ message: 'Recorded.', draft: null });
  const session = await settled(f.engine, 'reply-session');
  await f.engine.action(input);
  assert.equal(turns, 1);
  assert.equal(session.messages.filter((item) => item.id === 'stable-reply').length, 1);
  assert.equal(f.engine.activeCount, 0);
});

test('uncertain native chat creation cannot be retried into a duplicate chat', async (t) => {
  const f = fixture(t, {
    providerFactory: () => ({
      async turn(_session, input) {
        input.retain({ startup: { status: 'waiting' } });
        throw Error('Connection lost while creating chat.');
      },
      close() {},
    }),
  });
  await f.engine.action({ action: 'automate-start', requestId: 'uncertain' });
  const session = await settled(f.engine, 'uncertain');
  assert.equal(session.status, 'failed');
  await assert.rejects(
    f.engine.action({ action: 'automate-retry', id: session.id }),
    /original chat creation is uncertain/
  );
});

test('history from managed worktrees belongs to the project while escaped local records are excluded', async (t) => {
  const f = fixture(t);
  execFileSync('git', [
    '-C',
    f.root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'Fixture',
  ]);
  const checkout = join(f.root, 'checkout');
  execFileSync('git', ['-C', f.root, 'worktree', 'add', '--detach', checkout], { stdio: 'ignore' });
  mkdirSync(join(f.root, '.issues/conversations/issue-work'), { recursive: true });
  const transcript = join(checkout, '.issues/conversations/issue-work');
  mkdirSync(transcript, { recursive: true });
  writeFileSync(
    join(transcript, 'messages.jsonl'),
    JSON.stringify({ id: 'worktree', actor: 'human', at: '2026-11-17T10:00:00Z', body: 'Keep changes small.' })
  );
  writeFileSync(
    join(f.root, '.issues/factory-ui/lifecycle.json'),
    JSON.stringify({ version: 1, issues: { 'issue-work': { work: { checkout } } } })
  );
  const escaped = join(f.root, '.issues/conversations/issue-escape');
  symlinkSync(f.personalRoot, escaped);
  writeFileSync(
    join(f.personalRoot, 'messages.jsonl'),
    JSON.stringify({ id: 'foreign', at: '2026-11-17T10:00:00Z', body: 'Unrelated private history.' })
  );
  mkdirSync(join(f.root, '.issues/flows/issue-escape'), { recursive: true });
  const history = await collectAutomateHistory(
    f.service,
    automateHistoryWindow(4, 'weeks', now),
    new AbortController().signal
  );
  assert.deepEqual(
    history.messages.map((item) => item.text),
    ['Keep changes small.']
  );
  assert.equal(history.messages[0].role, 'user');
  assert.ok(history.coverage.gaps.some((item) => item.includes('issue-escape')));
});

test('project preview neither creates session storage nor rewrites or reconciles saved sessions', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timey-automate-preview-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ownershipClaims = 0;
  const service = {
    root,
    ownServer() {
      ownershipClaims++;
    },
  };
  const empty = new ProjectAutomateMe(service, { readOnly: true });
  assert.deepEqual(empty.view(), { sessions: [] });
  assert.equal(existsSync(join(root, '.issues')), false);
  await assert.rejects(empty.action({ action: 'automate-start', requestId: 'preview' }), /preview cannot run/);
  empty.close();
  assert.equal(ownershipClaims, 0);
  assert.equal(existsSync(join(root, '.issues')), false);
  const directory = join(root, '.issues/factory-ui/project-automate-me');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'existing.json');
  const bytes = JSON.stringify({
    version: 1,
    id: 'existing',
    status: 'running',
    createdAt: now.toISOString(),
    messages: [],
  });
  writeFileSync(path, bytes);
  const before = lstatSync(path);
  const preview = new ProjectAutomateMe(service, { readOnly: true });
  assert.equal(preview.view().sessions[0].status, 'running');
  assert.throws(() => preview.apply(preview.selected('existing'), {}), /preview cannot apply/);
  preview.close();
  assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.equal(lstatSync(path).mtimeMs, before.mtimeMs);
  assert.equal(ownershipClaims, 0);
});
