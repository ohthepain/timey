import { z } from 'zod';
import { LocalNotes } from './local-notes.mjs';
import { readSavedReport } from './report-document.mjs';
import { requireThat } from './common.mjs';

const handoff = z
  .object({
    action: z.enum(['discuss', 'link']),
    id: z.uuid(),
    issueId: z
      .string()
      .regex(/^[\w-]+$/)
      .optional(),
    basis: z.string().optional(),
  })
  .strict();

export async function localNoteAction(service, value, discuss) {
  service.ownServer();
  const notes = new LocalNotes(service.root);
  if (!['discuss', 'link'].includes(value.action)) return notes.action(value);
  const input = handoff.parse(value);
  if (input.action === 'link') {
    requireThat(input.basis, 'Refresh local notes before linking the issue.');
    readSavedReport(service.root, input.issueId, 'open');
    notes.link(input.id, input.issueId, input.basis);
  }
  const conversation = await discuss().prepareNote(notes.get(input.id));
  return { ...notes.view(), conversationId: conversation.selected.id };
}
