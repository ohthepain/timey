import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { digest, writeJson } from './common.mjs';

const maxNotes = 8;
export const workingNotesSchema = {
  type: 'array',
  maxItems: maxNotes,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      finding: { type: 'string', maxLength: 1000 },
      sources: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string' }, sha256: { type: 'string' } },
          required: ['path', 'sha256'],
        },
      },
    },
    required: ['finding', 'sources'],
  },
};
export const notesPath = (root) => join(root, '.issues/factory-ui/coordinator-notes.json');
function sourceValid(root, source) {
  try {
    if (!source || !/^[a-f0-9]{64}$/.test(source.sha256)) return false;
    const path = resolve(root, source.path),
      inside = relative(realpathSync(root), realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside) || lstatSync(path).isSymbolicLink()) return false;
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= 16 * 1024 * 1024 && digest(readFileSync(path)) === source.sha256;
  } catch {
    return false;
  }
}
export function currentNotes(root, issueId) {
  let notes = [];
  try {
    notes = JSON.parse(readFileSync(notesPath(root), 'utf8')).notes;
  } catch {
    return [];
  }
  if (!Array.isArray(notes)) return [];
  return notes
    .filter(
      (note) =>
        typeof note.finding === 'string' &&
        note.finding.length <= 1000 &&
        Array.isArray(note.sources) &&
        note.sources.length > 0 &&
        note.sources.length <= 6 &&
        note.sources.every((source) => sourceValid(root, source)) &&
        (issueId === undefined || note.issueId === issueId || note.issueId === null)
    )
    .slice(-80);
}
export function retainNotes(root, issueId, proposed) {
  if (!Array.isArray(proposed)) return;
  const scope = issueId || null;
  const notes = currentNotes(root).filter((note) => note.issueId !== scope);
  for (const note of proposed.slice(0, maxNotes)) {
    if (
      typeof note?.finding !== 'string' ||
      !note.finding.trim() ||
      note.finding.length > 1000 ||
      !Array.isArray(note.sources) ||
      !note.sources.length ||
      note.sources.length > 6 ||
      !note.sources.every((source) => sourceValid(root, source))
    )
      continue;
    notes.push({
      issueId: scope,
      finding: note.finding,
      sources: note.sources.map(({ path, sha256 }) => ({ path, sha256 })),
    });
  }
  // Notes for other issues remain discoverable on demand, not injected into every turn.
  writeJson(notesPath(root), { version: 1, notes: notes.slice(-80) });
}
export function notesSchema(schema) {
  return schema
    ? {
        ...schema,
        properties: { ...schema.properties, working_notes: workingNotesSchema },
        required: [...(schema.required || []), 'working_notes'],
      }
    : {
        type: 'object',
        additionalProperties: false,
        properties: { reply: { type: 'string' }, working_notes: workingNotesSchema },
        required: ['reply', 'working_notes'],
      };
}
export function takeNotes(root, issueId, text, structured, onError = () => {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
  if (!Object.hasOwn(value, 'working_notes')) return text;
  try {
    retainNotes(root, issueId, value.working_notes);
  } catch (error) {
    onError(error);
  }
  delete value.working_notes;
  return structured ? JSON.stringify(value) : value.reply;
}
