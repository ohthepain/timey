import { StaveNote, Tuplet } from 'vexflow';
import { BarSource, BeatSource } from '~/types/BarSource';
import { Beat } from '~/types/Beat';
import { parseBarSource } from '~/lib/parseBarSource';
import { staveNoteForBeatNote, tupletStartIndices, vexKeysForBeatNote } from '~/lib/staveNoteHelpers';

const hihat = 'g/5/x';
const snare = 'e/5';
const kick = 'g/4';

export function ConvertNoteToMidiNote(note: string): number {
  switch (note.slice(0, 3)) {
    case 'g/5':
      return 42; // Closed hi-hat, edge
    case 'g/4':
      return 36; // MIDI note number for kick
    case 'e/5':
      return 38; // MIDI note number for snare
    default:
      return -1; // Invalid note
  }
}

// Function to parse the input string into structured data
export const ParseBeatString = (input: string) => {
  const lines = input.split('\n');
  const beatNotes: any[] = [];
  const tuples: any[] = [];

  lines.forEach((line) => {
    line = line.trim();
    if (line.startsWith('note,')) {
      console.log(`note: ${line}`);

      // Regular expression to match the note line
      const noteRegex = /^note,(\d+),(\d+[t]?),\[(.+?)\],(\d+),(\d+),(\d+),(\d+),(\d+)$/;
      const match = line.match(noteRegex);

      if (match) {
        const [, index, durationCode, keysString, bar, beat, divisionNum, subDivisionNum, numSubDivisions] = match;

        // Create a BeatNote for each key
        beatNotes.push({
          // Fix indexes so that they don't restart at 0 for each bar
          index: beatNotes.length, // parseInt(index, 10),
          duration: parseInt(durationCode, 10),
          noteString: keysString,
          barNum: parseInt(bar, 10),
          beatNum: parseInt(beat, 10),
          divisionNum: parseInt(divisionNum, 10),
          subDivisionNum: parseInt(subDivisionNum, 10),
          numSubDivisions: parseInt(numSubDivisions, 10),
          velocity: 127, // Default velocity
        });
      } else {
        console.warn(`Failed to parse line: ${line}`);
      }
    }
  });

  return { beatNotes, tuples };
};

// Parse the editable strings into a machine-readable format
export function ParseBeatSource(beatSource: BeatSource): string {
  const numBars = beatSource.bars.length;
  console.log(`ParseBeatStrings: input: ${numBars} bars`);
  let result = '';

  for (let barNum = 0; barNum < numBars; barNum++) {
    const bar: BarSource = beatSource.bars[barNum];
    result += parseBarSource(barNum, [bar.kick, bar.hihat, bar.snare, bar.accent]);
    result += '\n';
  }

  console.log(`ParseBeatStrings: ${result}`);
  return result;
}

export class TupletRecord {
  barNum: number;
  notes: StaveNote[];
  options: { numNotes: number; notesOccupied: number; bracketed: boolean };
  tuplet: Tuplet;

  constructor(
    barNum: number,
    notes: StaveNote[],
    options: { numNotes: number; notesOccupied: number; bracketed: true }
  ) {
    this.barNum = barNum;
    this.notes = notes;
    this.options = options;
    this.tuplet = new Tuplet(this.notes, this.options);
  }
}

export class NoteEntry {
  index: number;
  keys: string[];
  durationCode: string;
  staveNote: StaveNote;
  barNum: number;
  beatNum: number;
  divisionNum: number;
  subDivisionNum: number;
  numSubDivisions: number;

  constructor(
    index: number,
    keys: string[],
    durationCode: string,
    staveNote: StaveNote,
    barNum: number,
    beatNum: number,
    divisionNum: number,
    subDivisionNum: number,
    numSubDivisions: number
  ) {
    this.index = index;
    this.keys = keys;
    this.durationCode = durationCode;
    this.staveNote = staveNote;
    this.barNum = barNum;
    this.beatNum = beatNum;
    this.divisionNum = divisionNum;
    this.subDivisionNum = subDivisionNum;
    this.numSubDivisions = numSubDivisions;
  }

}

/** Start position of a note in milliseconds at the given tempo (BPM). */
export function noteStartPositionMsec(
  note: Pick<NoteEntry, 'barNum' | 'beatNum' | 'divisionNum' | 'subDivisionNum' | 'numSubDivisions'>,
  tempo: number
): number {
  const beatDuration = (60 / tempo) * 1000;
  const divisionDuration = beatDuration / 2;
  const subDivisionDuration = divisionDuration / note.numSubDivisions;

  const barTime = note.barNum * beatDuration * 4; // Assuming 4/4 time signature
  const beatTime = note.beatNum * beatDuration;
  const divisionTime = note.divisionNum * divisionDuration;
  const subDivisionTime = note.subDivisionNum * subDivisionDuration;

  return barTime + beatTime + divisionTime + subDivisionTime;
}

export function MakeStaveNotesFromBeat(beat: Beat): {
  noteEntries: NoteEntry[];
  tuplets: TupletRecord[];
} {
  const noteEntries = beat.beatNotes.map((beatNote) => {
    const keys = vexKeysForBeatNote(beatNote.noteString);
    const staveNote = staveNoteForBeatNote(beatNote);
    return new NoteEntry(
      beatNote.index,
      keys,
      beatNote.duration.toString(),
      staveNote,
      beatNote.barNum,
      beatNote.beatNum,
      beatNote.divisionNum,
      beatNote.subDivisionNum,
      beatNote.numSubDivisions
    );
  });

  const tuplets = tupletStartIndices(noteEntries).flatMap((start) => {
    const beatStartIndex = noteEntries.findIndex((entry) => entry.barNum === start.barNum);
    const noteRecords = noteEntries.slice(beatStartIndex + start.index, beatStartIndex + start.index + 2);
    return [
      new TupletRecord(start.barNum, noteRecords.map((record) => record.staveNote), {
        numNotes: 3,
        notesOccupied: 2,
        bracketed: true,
      }),
    ];
  });

  return { noteEntries, tuplets };
}

export { createBeatSourceFromBeat } from '~/lib/beatSourceFromBeat';
