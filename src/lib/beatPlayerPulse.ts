import { ConvertNoteToMidiNote, noteStartPositionMsec, type NoteEntry } from '~/lib/ParseBeat';

export function midiNotesForEntry(entry: NoteEntry): number[] {
  const notes: number[] = [];
  for (const key of entry.keys) {
    const midiNote = ConvertNoteToMidiNote(key);
    if (midiNote >= 0) notes.push(midiNote);
  }
  return notes;
}

export function nextScheduleTimeMsec(
  nextNote: NoteEntry,
  bpm: number,
  loopLengthMsec: number,
  numLoops: number
): number {
  return noteStartPositionMsec(nextNote, bpm) + loopLengthMsec * numLoops;
}

export function canProcessBeatPulse(options: {
  hasBeat: boolean;
  isRunning: boolean;
  isPlaying: boolean;
  noteCount: number;
  elapsedMsec: number;
  nextNoteStartMsec: number;
}) {
  return (
    options.hasBeat &&
    options.isRunning &&
    options.isPlaying &&
    options.noteCount > 0 &&
    options.elapsedMsec >= options.nextNoteStartMsec
  );
}

export function advanceNoteIndex(currentIndex: number, totalNotes: number) {
  let noteIndex = currentIndex + 1;
  let numLoops = 0;
  if (noteIndex >= totalNotes) {
    noteIndex = 0;
    numLoops = 1;
  }
  return { noteIndex, numLoopsDelta: numLoops };
}
