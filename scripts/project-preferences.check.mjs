import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import {
  readProjectPreferences,
  saveProjectPreferences,
  normalizeFactoryHotkey,
  effectiveProjectPrompt,
} from './factory-ui/project-preferences.mjs';
import { createProjectDiscussProvider } from './factory-ui/project-discuss-provider.mjs';

function fixture(t) {
  const evidence = resolve('.issues/evidence');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'preferences-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = { root, ownServer() {} };
  return {
    root,
    service,
    save: (changes) => saveProjectPreferences(service, { revision: readProjectPreferences(root).revision, ...changes }),
  };
}

test('four project chat overrides show their effective source, remain isolated and restore explicitly', (t) => {
  const f = fixture(t);
  const other = fixture(t);
  const before = readProjectPreferences(f.root);
  assert.deepEqual(Object.keys(before.prompts), ['project', 'issue', 'report', 'investigation']);
  for (const [key, prompt] of Object.entries(before.prompts)) {
    assert.equal(prompt.value, prompt.default);
    assert.equal(prompt.overridden, false);
    assert.equal(effectiveProjectPrompt(f.root, key), prompt.value);
  }
  const updated = f.save({
    prompts: {
      project: 'Project instructions',
      issue: 'Issue instructions',
      report: 'Report instructions',
      investigation: 'Investigation instructions',
    },
  });
  for (const key of Object.keys(updated.prompts)) {
    assert.equal(updated.prompts[key].overridden, true);
    assert.equal(updated.prompts[key].source, 'user/factory-preferences.json');
    assert.notEqual(updated.prompts[key].value, before.prompts[key].value);
  }
  assert.deepEqual(readProjectPreferences(other.root), before);
  const restored = f.save({ prompts: { project: null } });
  assert.equal(restored.prompts.project.value, before.prompts.project.value);
  assert.equal(restored.prompts.project.overridden, false);
  assert.equal(restored.prompts.issue.value, 'Issue instructions');
});

test('hotkey saves normalize aliases, block duplicates atomically and reject stale revisions', (t) => {
  const f = fixture(t);
  const initial = readProjectPreferences(f.root);
  assert.deepEqual(initial.hotkeys.values, { dictateHot: 'Alt+D', dictateCold: '', newNote: 'Alt+N', newIssue: 'N' });
  assert.equal(normalizeFactoryHotkey('option + control + n'), 'Ctrl+Alt+N');
  assert.throws(() => f.save({ hotkeys: { newIssue: 'Option+n' } }), /distinct/);
  assert.equal(readProjectPreferences(f.root).revision, initial.revision);
  assert.throws(() => f.save({ hotkeys: { dictateCold: 'Alt+D' } }), /distinct/);
  assert.equal(readProjectPreferences(f.root).revision, initial.revision);
  const saved = f.save({
    hotkeys: { newIssue: 'ctrl+shift+i', dictateCold: 'Alt+C' },
    prompts: { project: 'A project override' },
  });
  assert.equal(saved.hotkeys.values.newIssue, 'Ctrl+Shift+I');
  assert.equal(saved.hotkeys.values.dictateCold, 'Alt+C');
  assert.throws(
    () => saveProjectPreferences(f.service, { revision: initial.revision, hotkeys: initial.hotkeys.defaults }),
    /changed/
  );
  assert.throws(() => f.save({ hotkeys: { otherAction: 'Alt+P' } }), /Unrecognized/);
  assert.throws(() => f.save({ hotkeys: { newNote: 'Alt+Alt+N' } }), /combination/);
  const restored = f.save({ hotkeys: saved.hotkeys.defaults });
  assert.deepEqual(restored.hotkeys.values, initial.hotkeys.values);
  assert.equal(restored.prompts.project.value, 'A project override');
});

test('browser hotkey matching reads saved configuration and changes only after apply', async (t) => {
  const f = fixture(t);
  const window = {};
  const document = { dispatchEvent() {}, getElementById() {} };
  const context = {
    window,
    document,
    CustomEvent: class {},
    fetch: async () => ({ ok: true, json: async () => readProjectPreferences(f.root) }),
  };
  vm.runInNewContext(readFileSync(new URL('./factory-ui/hotkeys-ui.js', import.meta.url), 'utf8'), context);
  await window.FactoryHotkeys.refresh();
  const event = {
    code: 'KeyN',
    key: 'n',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
  };
  assert.equal(window.FactoryHotkeys.matches(event, 'newIssue'), true);
  assert.equal(window.FactoryHotkeys.matches({ ...event, altKey: true }, 'newIssue'), false);
  assert.equal(window.FactoryHotkeys.matches({ ...event, repeat: true }, 'newIssue'), false);
  assert.equal(window.FactoryHotkeys.matches({ ...event, repeat: true }, 'newIssue', true), true);
  const values = f.save({ hotkeys: { newIssue: 'Ctrl+Shift+I' } }).hotkeys.values;
  assert.equal(window.FactoryHotkeys.matches(event, 'newIssue'), true);
  window.FactoryHotkeys.apply(values);
  assert.equal(window.FactoryHotkeys.matches(event, 'newIssue'), false);
  assert.equal(
    window.FactoryHotkeys.matches({ ...event, code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true }, 'newIssue'),
    true
  );
});

test('project and report provider turns consume their separate saved prompts', async (t) => {
  const f = fixture(t);
  f.save({ prompts: { project: 'Use the project prompt.', report: 'Use the report prompt.' } });
  const calls = [];
  const connection = {
    ready: async () => {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [{ skills: [] }] };
      return { thread: { id: 'thread', status: { type: 'idle' } } };
    },
    async turn() {
      return 'Done.';
    },
  };
  const provider = createProjectDiscussProvider(f.service, { connection, tools: { definitions: [] } });
  for (const kind of ['project', 'report']) {
    const session = { messages: [] };
    await provider.turn(
      session,
      {
        id: kind,
        text: 'Hello',
        settings: { clarificationSkill: 'none' },
        ...(kind === 'report' ? { reportContext: { id: 'retained' } } : {}),
      },
      { signal: new AbortController().signal, event() {}, retain: (patch) => Object.assign(session, patch) }
    );
    const start = calls.filter(({ method }) => method === 'thread/start').at(-1);
    assert.ok(start.params.developerInstructions.startsWith(`Use the ${kind} prompt.`));
  }
});
