import { z } from 'zod';

const position = z.number().int().nonnegative();
const musicalNoteInput = z.strictObject({
  index: position,
  duration: z.number().int().positive(),
  noteString: z.string().min(1),
  barNum: position,
  beatNum: position,
  divisionNum: position,
  subDivisionNum: position,
  numSubDivisions: z.number().int().positive(),
  velocity: z.number().int().min(0).max(127),
  microtiming: z.number().int().optional(),
});
const fields = {
  name: z.string().trim().min(1),
  index: z.number().int().default(0),
  description: z.string().nullable().optional(),
  moduleId: z.string().min(1),
};
export const createBeatInput = z.strictObject({ ...fields, beatNotes: z.array(musicalNoteInput) });
export const createBeatApiInput = z.strictObject({ ...fields, beatString: z.string().min(1) });
export const copyBeatInput = z.strictObject({ id: z.string().min(1), moduleId: z.string().min(1) });
export type NewBeat = z.infer<typeof createBeatInput>;

/** Explicit content projection: identities, relations and private practice never cross this boundary. */
export function musicalNote(note: z.infer<typeof musicalNoteInput>) {
  return {
    index: note.index,
    duration: note.duration,
    noteString: note.noteString,
    barNum: note.barNum,
    beatNum: note.beatNum,
    divisionNum: note.divisionNum,
    subDivisionNum: note.subDivisionNum,
    numSubDivisions: note.numSubDivisions,
    velocity: note.velocity,
    microtiming: note.microtiming ?? 0,
  };
}

export function copiedBeatName(name: string) {
  const match = name.match(/(.*?)(\d+)$/);
  return match ? `${match[1]}${parseInt(match[2], 10) + 1}` : `Copy of ${name}`;
}
