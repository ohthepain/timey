import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitFixture } from './git-fixture.mjs';
import { LocalNotes } from './factory-ui/local-notes.mjs';
import { git } from './factory-ui/common.mjs';
import { ProjectDiscuss } from './factory-ui/project-discuss.mjs';
import { createProjectDiscussTools } from './factory-ui/project-discuss-tools.mjs';
import { listAvailableSkills } from './factory-ui/skills.mjs';

test('captures are literal, local, durable and shared by the project worktrees', (t) => {
  const { root } = gitFixture(t, 'local-notes-');
  writeFileSync(join(root, 'source.txt'), 'source');
  git(root, 'add', 'source.txt');
  git(root, 'commit', '-qm', 'Fixture');
  const notes = new LocalNotes(root);
  assert.deepEqual(notes.view().notes, []);
  assert.equal(existsSync(notes.directory), false);
  const text = '  Remember `$(literal)`\n- [ ] Try this  ';
  const id = randomUUID();
  notes.action({ action: 'create', id, text });
  notes.action({ action: 'create', id, text });
  assert.equal(notes.view().notes.length, 1);
  assert.equal(notes.get(id).text, text);
  assert.match(git(root, 'check-ignore', '.local-notes/notes.json'), /notes.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const worktree = join(root, 'worktree');
  git(root, 'worktree', 'add', '-qb', 'other', worktree);
  assert.equal(new LocalNotes(worktree).get(id).text, text);
  const script = new URL('./local-note.mjs', import.meta.url);
  const output = JSON.parse(
    execFileSync(process.execPath, [script.pathname, 'add', 'CLI capture'], { cwd: worktree, encoding: 'utf8' })
  );
  assert.equal(output.notes[0].text, 'CLI capture');
});

test('linked note display numbers follow the registry without changing saved notes or edit basis', (t) => {
  const { root } = gitFixture(t, 'local-note-numbers-');
  const notes = new LocalNotes(root);
  const created = notes.action({ action: 'create', text: 'Linked thought' }).notes[0];
  notes.link(created.id, 'linked-issue', notes.view().basis);
  const before = notes.view();
  const saved = readFileSync(notes.path, 'utf8');
  assert.equal(existsSync(join(root, '.issues/issue-numbers.json')), false);
  assert.equal(before.issueNumbers['linked-issue'], undefined);
  mkdirSync(join(root, '.issues'), { recursive: true });
  writeFileSync(
    join(root, '.issues/issue-numbers.json'),
    JSON.stringify({
      version: 1,
      next: 183,
      issues: { 'linked-issue': 182 },
    })
  );
  assert.equal(notes.view().issueNumbers['linked-issue'], 182);
  assert.equal(notes.view().basis, before.basis);
  assert.equal(readFileSync(notes.path, 'utf8'), saved);
  notes.action({ action: 'edit', id: created.id, text: 'Still editable', basis: before.basis });
  assert.equal(notes.get(created.id).text, 'Still editable');
});

test('edits, completion, ordering and deletion preserve other notes and reject stale writes', (t) => {
  const { root } = gitFixture(t, 'local-notes-edits-');
  const notes = new LocalNotes(root);
  const first = notes.action({ action: 'create', text: 'First' }).notes[0].id;
  const stale = notes.view();
  const second = notes.action({ action: 'create', text: 'Second' }).notes[0].id;
  assert.throws(() => notes.action({ action: 'edit', id: first, text: 'Lost', basis: stale.basis }), /changed/);
  const act = (input) => notes.action({ ...input, basis: notes.view().basis });
  act({ action: 'edit', id: first, text: 'Updated\nbody' });
  act({ action: 'complete', id: first, done: true });
  assert.equal(notes.get(first).done, true);
  act({ action: 'move', id: first, direction: 'up' });
  assert.deepEqual(
    notes.view().notes.map((note) => note.id),
    [first, second]
  );
  act({ action: 'delete', id: first });
  assert.deepEqual(
    notes.view().notes.map((note) => note.id),
    [second]
  );
  assert.throws(() => notes.action({ action: 'create', text: '   ' }));
  writeFileSync(join(notes.directory, 'write.lock'), '');
  assert.throws(() => notes.action({ action: 'create', text: 'Concurrent' }), /being saved/);
  assert.equal(notes.view().notes.length, 1);
});

test('tracked and redirected storage is rejected without overwriting data', (t) => {
  const { root } = gitFixture(t, 'local-notes-boundary-');
  const notes = new LocalNotes(root);
  mkdirSync(notes.directory);
  writeFileSync(notes.path, '[]');
  git(root, 'add', '-f', '.local-notes/notes.json');
  assert.throws(() => notes.action({ action: 'create', text: 'Private' }), /Git tracking/);
  assert.equal(readFileSync(notes.path, 'utf8'), '[]');
  const other = join(root, 'other');
  mkdirSync(other);
  symlinkSync(notes.directory, join(other, '.local-notes'));
  // Use a non-Git root so resolution cannot hide the redirected folder.
  const redirected = new LocalNotes(root);
  redirected.directory = join(other, '.local-notes');
  redirected.path = join(redirected.directory, 'notes.json');
  assert.throws(() => redirected.view(), /regular local/);
});

test('Discuss prepares context and a first prompt without running a model, then offers explicit deletion', async (t) => {
  const { root } = gitFixture(t, 'local-note-discuss-');
  const notes = new LocalNotes(root);
  const note = notes.action({ action: 'create', text: 'Remember the capture shortcut' }).notes[0];
  let turns = 0;
  const service = { root, ownServer() {} };
  const discuss = new ProjectDiscuss(service, {
    modelSettings: () => ({ defaults: { model: 'test', effort: 'high' }, models: [{ id: 'test' }], efforts: ['high'] }),
    createProvider: () => ({
      async turn() {
        turns++;
        return { text: 'Reply' };
      },
      close() {},
    }),
  });
  t.after(() => discuss.close());
  const prepared = (await discuss.prepareNote(note)).selected;
  assert.equal(turns, 0);
  assert.equal(prepared.status, 'idle');
  assert.equal(prepared.messages.length, 1);
  assert.match(prepared.messages[0].text, /Remember the capture shortcut/);
  assert.match(prepared.draft.text, /think through/);
  await discuss.action({ action: 'draft', conversationId: prepared.id, draft: { text: 'My own question' } });
  const linked = (await discuss.prepareNote({ ...note, issueId: '20261120-test' })).selected;
  assert.equal(linked.id, prepared.id);
  assert.equal(linked.draft.text, 'My own question');
  assert.match(linked.messages.at(-1).text, /\[the new issue\]\(\/\?issue=20261120-test\)/);
  assert.equal(notes.view().notes.length, 1);
  assert.equal((await discuss.prepareNote({ ...note, issueId: '20261120-test' })).selected.messages.length, 2);
  await discuss.action({ action: 'delete-note', conversationId: prepared.id, noteId: note.id });
  assert.equal(notes.view().notes.length, 0);
  assert.equal(discuss.read(prepared.id).messages.at(-1).localNoteDeleted, true);
  assert.equal(turns, 0);
});

test('project chat capture tools preserve permission boundaries and keep projects separate', async (t) => {
  const { root } = gitFixture(t, 'local-note-tools-');
  const service = { root, ownServer() {} };
  const tools = createProjectDiscussTools(service);
  await tools.invoke('local_note', { action: 'create', text: 'From chat' });
  assert.equal((await tools.invoke('local_notes', {})).notes[0].text, 'From chat');
  const readOnly = createProjectDiscussTools(service, { readOnly: true });
  await assert.rejects(() => readOnly.invoke('local_note', { action: 'create', text: 'Blocked' }), /preview/);
  const other = gitFixture(t, 'other-note-project-');
  assert.equal(new LocalNotes(other.root).view().notes.length, 0);
  const available = await listAvailableSkills({ ready: async () => {}, call: async () => ({ data: [] }) }, root);
  const skill = available.find((entry) => entry.name === 'local-note');
  assert.equal(skill.source, 'Factory');
  assert.notEqual(skill.allowImplicitInvocation, false);
});
