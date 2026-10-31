import { Stem, StaveNote } from 'vexflow';
import type { BeatNote } from '~/types/BeatNote';

const KEY_TO_VEX = new Map<string, string>([
  ['hihat', 'g/5/x'],
  ['snare', 'e/5'],
  ['kick', 'g/4'],
  ['rest', 'g/4/x'],
]);

export function vexKeysForBeatNote(noteString: string): string[] {
  return noteString.split(', ').map((key) => KEY_TO_VEX.get(key) ?? 'g/4/x');
}

export function staveNoteForBeatNote(beatNote: BeatNote) {
  return new StaveNote({
    keys: vexKeysForBeatNote(beatNote.noteString),
    duration: beatNote.duration.toString(),
    stemDirection: Stem.UP,
  });
}

export type TupletCandidate = {
  barNum: number;
  index: number;
  numSubDivisions: number;
  subDivisionNum: number;
  staveNote: StaveNote;
};

export function tupletStartIndices(entries: TupletCandidate[]) {
  const starts: Array<{ barNum: number; index: number; staveNote: StaveNote }> = [];
  for (const entry of entries) {
    if (entry.numSubDivisions !== 3 || entry.subDivisionNum !== 0) continue;
    starts.push({ barNum: entry.barNum, index: entry.index, staveNote: entry.staveNote });
  }
  return starts;
}
