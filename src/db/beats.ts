import { and, eq, isNull } from 'drizzle-orm';
import { beatNotes, beats, type DomainBeatNote } from '../../domain/schema';
import type { DomainDb } from '~/config/db';

export function contentNotes(notes: DomainBeatNote[]) {
  return notes.filter((note) => note.performanceId === null);
}

export async function loadContentBeat(db: DomainDb, id: string) {
  const [beat] = await db.select().from(beats).where(eq(beats.id, id)).limit(1);
  if (!beat) return null;
  const notes = await db
    .select()
    .from(beatNotes)
    .where(and(eq(beatNotes.beatId, id), isNull(beatNotes.performanceId)));
  return { ...beat, beatNotes: notes };
}
