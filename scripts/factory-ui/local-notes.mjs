import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, git, requireThat, writeJson } from './common.mjs';

const noteText = z
  .string()
  .min(1)
  .max(24000)
  .refine((value) => value.trim().length > 0, 'Enter a note.');
const note = z
  .object({
    id: z.uuid(),
    text: noteText,
    done: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    issueId: z
      .string()
      .regex(/^[\w-]+$/)
      .optional(),
  })
  .strict();
export const localNoteActionSchema = z
  .object({
    action: z.enum(['create', 'edit', 'complete', 'delete', 'move']),
    id: z.uuid().optional(),
    text: noteText.optional(),
    done: z.boolean().optional(),
    direction: z.enum(['up', 'down']).optional(),
    basis: z.string().optional(),
  })
  .strict();

function projectRoot(root) {
  try {
    const worktree = git(root, 'worktree', 'list', '--porcelain', '-z').split('\0')[0];
    return worktree.startsWith('worktree ') ? worktree.slice(9) : resolve(root);
  } catch {
    return resolve(root);
  }
}

export class LocalNotes {
  constructor(root) {
    this.root = projectRoot(root);
    this.directory = join(this.root, '.local-notes');
    this.path = join(this.directory, 'notes.json');
  }
  read() {
    for (const path of [this.directory, this.path]) {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      requireThat(!entry?.isSymbolicLink(), 'Local notes must use a regular local folder and file.');
    }
    return existsSync(this.path) ? z.array(note).parse(JSON.parse(readFileSync(this.path, 'utf8'))) : [];
  }
  view() {
    const notes = this.read();
    return { notes, basis: digest(JSON.stringify(notes)) };
  }
  get(id) {
    const found = this.read().find((entry) => entry.id === id);
    requireThat(found, 'This local note no longer exists.');
    return found;
  }
  ensureLocal() {
    try {
      git(this.root, 'rev-parse', '--git-dir');
    } catch {
      return;
    }
    requireThat(
      !git(this.root, 'ls-files', '--', '.local-notes').trim(),
      'Remove local notes from Git tracking before saving.'
    );
    const exclude = resolve(this.root, git(this.root, 'rev-parse', '--git-path', 'info/exclude'));
    mkdirSync(dirname(exclude), { recursive: true });
    const content = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!content.split(/\r?\n/).includes('/.local-notes/')) appendFileSync(exclude, '\n/.local-notes/\n');
  }
  update(basis, edit) {
    this.read();
    this.ensureLocal();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'write.lock');
    let handle;
    try {
      handle = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw Error('Local notes are being saved. Refresh and retry.');
      throw error;
    }
    try {
      const current = this.view();
      requireThat(
        basis === undefined || basis === current.basis,
        'Local notes changed. Refresh before saving this edit.'
      );
      edit(current.notes);
      writeJson(this.path, z.array(note).parse(current.notes));
      return this.view();
    } finally {
      closeSync(handle);
      unlinkSync(lock);
    }
  }
  action(value) {
    const input = localNoteActionSchema.parse(value);
    requireThat(input.action === 'create' || input.basis, 'Refresh local notes before changing them.');
    return this.update(input.basis, (notes) => {
      if (input.action === 'create') {
        const text = noteText.parse(input.text);
        const id = input.id || randomUUID();
        const existing = notes.find((entry) => entry.id === id);
        if (existing) {
          requireThat(existing.text === text, 'This capture already contains different text.');
          return;
        }
        const now = new Date().toISOString();
        notes.unshift({ id, text, done: false, createdAt: now, updatedAt: now });
        return;
      }
      const index = notes.findIndex((entry) => entry.id === input.id);
      requireThat(index !== -1, 'This local note no longer exists.');
      if (input.action === 'delete') notes.splice(index, 1);
      else if (input.action === 'move') {
        requireThat(input.direction, 'Choose up or down.');
        const target = index + (input.direction === 'up' ? -1 : 1);
        if (target >= 0 && target < notes.length) [notes[index], notes[target]] = [notes[target], notes[index]];
      } else {
        if (input.action === 'edit') notes[index].text = noteText.parse(input.text);
        else notes[index].done = z.boolean().parse(input.done);
        notes[index].updatedAt = new Date().toISOString();
      }
    });
  }
  link(id, issueId, basis) {
    return this.update(basis, (notes) => {
      const entry = notes.find((item) => item.id === id);
      requireThat(entry, 'This local note no longer exists.');
      entry.issueId = issueId;
    });
  }
}
