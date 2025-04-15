import { Stem, StaveNote, Tuplet } from 'vexflow';
// import { Beat, BeatNote } from '@prisma/client';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';

const hihat = 'g/5/x';
const snare = 'e/5';
const kick = 'g/4';

export function ConvertNoteToMidiNote(note: string): number {
  switch (note.slice(0, 3)) {
    case 'g/5':
      return 22; // Closed hi-hat, edge
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
        console.log(`numSubDivisions: ${numSubDivisions} keysString ${keysString}`);
        console.log(
          `note: ${index} ${durationCode} ${keysString} bar ${bar} beat ${beat} div ${divisionNum} sub ${subDivisionNum} of ${numSubDivisions}`
        );

        // // Split the keysString into individual keys
        // const keys = keysString.split(', ').map((key) => key.trim());
        // console.log(`keys: ${keys}`);

        // Create a BeatNote for each key
        // keys.forEach((key) => {
        beatNotes.push({
          index: parseInt(index, 10),
          duration: parseInt(durationCode, 10),
          noteString: keysString,
          barNum: parseInt(bar, 10),
          beatNum: parseInt(beat, 10),
          divisionNum: parseInt(divisionNum, 10),
          subDivisionNum: parseInt(subDivisionNum, 10),
          numSubDivisions: parseInt(numSubDivisions, 10),
          velocity: 127, // Default velocity
        });
        // });
      } else {
        console.warn(`Failed to parse line: ${line}`);
      }
    }
  });

  return { beatNotes, tuples };
};

// Parse the editable strings into a machine-readable format
export function ParseBeatStrings(beatStrings: string[][]): string {
  console.log(`ParseBeatStrings: input: ${beatStrings.length}`);
  let result = '';
  const numBars = Math.max(...beatStrings.map((arr) => arr.length)); // Determine the number of bars

  for (let barNum = 0; barNum < numBars; barNum++) {
    // Collect the strings for the current bar from all tracks
    const currentBarStrings = beatStrings.map((track) => track[barNum] || '');
    result += ParseBarStrings(barNum, currentBarStrings);
    result += '\n';
  }

  console.log(`ParseBeatStrings: ${result}`);
  return result;
}

/**
 * Converts the source strings into a readable string format that represents each StaveNote.
 * @param hihatStr - String representing hi-hat beats.
 * @param kickStr - String representing kick beats.
 * @param snareStr - String representing snare beats.
 * @returns A readable string format of the notes.
 */
export function ParseBarStrings(barNum: number, beatStrings: string[]): string {
  const beatArrays = beatStrings.map((beatStr) => beatStr.split(','));

  const result: string[] = ['// note,index,duration,keys,barNum,beatNum,divisionNum,subDivisionNum,numSubDivisions'];
  const tuples: string[] = ['// tuple,barNum,beatNum,startIndex,numNotes'];
  let noteIndex = 1;
  let notesThisQuarterNote = 0;
  let beatNumber = -1;
  let divisionNumber = -1;

  result.push(`bar,${barNum}`);

  const maxBeats = Math.max(...beatArrays.map((arr) => arr.length));

  for (let i = 0; i < maxBeats; i++) {
    const currentBeats = beatArrays.map((arr) => arr[i] || '');

    // Determine the quarter note label
    const quarterNoteIndex = Math.floor(i / 2);
    if (i % 2 === 0) {
      beatNumber++;
      divisionNumber = -1;
      notesThisQuarterNote = 0;
      result.push(`beat,${quarterNoteIndex}`);
    }

    divisionNumber++;

    // Process each 8th note
    if (currentBeats.some((beat) => beat.length === 3)) {
      // Triplet case
      tuples.push(`tuple,${barNum},${quarterNoteIndex},${notesThisQuarterNote},3`);
      for (let j = 0; j < 3; j++) {
        const keys: string[] = [];
        currentBeats.forEach((beat) => {
          if (beat[j] === 'h') keys.push('hihat');
          if (beat[j] === 'k') keys.push('kick');
          if (beat[j] === 's') keys.push('snare');
        });
        if (keys.length === 0) keys.push('rest');

        result.push(`note,${noteIndex++},16,[${keys.join(', ')}],${barNum},${beatNumber},${divisionNumber},${j},3`);
        ++notesThisQuarterNote;
      }
    } else if (currentBeats.some((beat) => beat.length === 2)) {
      // Two 16th notes
      for (let j = 0; j < 2; j++) {
        const keys: string[] = [];
        currentBeats.forEach((beat) => {
          if (beat[j] === 'h') keys.push('hihat');
          if (beat[j] === 'k') keys.push('kick');
          if (beat[j] === 's') keys.push('snare');
        });
        if (keys.length === 0) keys.push('rest');

        result.push(`note,${noteIndex++},16,[${keys.join(', ')}],${barNum},${beatNumber},${divisionNumber},${j},2`);
        ++notesThisQuarterNote;
      }
    } else {
      // Single 8th note
      const keys: string[] = [];
      currentBeats.forEach((beat) => {
        if (beat.includes('h')) keys.push('hihat');
        if (beat.includes('k')) keys.push('kick');
        if (beat.includes('s')) keys.push('snare');
      });
      if (keys.length === 0) keys.push('rest');

      result.push(`note,${noteIndex++},8,[${keys.join(', ')}],${barNum},${beatNumber},${divisionNumber},0,1`);
      ++notesThisQuarterNote;
    }
  }

  return [...result, ...tuples].join('\n');
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

  /**
   * Calculates the start time of this note in milliseconds.
   * @param tempo - The tempo in beats per minute (BPM).
   * @returns The start time of the note in milliseconds.
   */
  getStartTimeMsec(tempo: number): number {
    const beatDuration = (60 / tempo) * 1000;
    const divisionDuration = beatDuration / 2;
    const subDivisionDuration = divisionDuration / this.numSubDivisions;

    const barTime = this.barNum * beatDuration * 4; // Assuming 4/4 time signature
    const beatTime = this.beatNum * beatDuration;
    const divisionTime = this.divisionNum * divisionDuration;
    const subDivisionTime = this.subDivisionNum * subDivisionDuration;

    return barTime + beatTime + divisionTime + subDivisionTime;
  }
}

export function MakeStaveNotesFromBeat(beat: Beat): {
  noteEntries: NoteEntry[];
  tuplets: TupletRecord[];
} {
  const noteEntries: NoteEntry[] = [];

  let currentNotesArray: StaveNote[] | null = [];

  for (const beatNote of beat.beatNotes) {
    const keys = beatNote.noteString.split(', ').map((key) => {
      if (key === 'hihat') return hihat;
      if (key === 'snare') return snare;
      if (key === 'kick') return kick;
      console.warn(`Unknown key: ${key}`);
      return 'g/4/x'; // Default to rest
    });

    const staveNote = new StaveNote({
      keys,
      duration: beatNote.duration.toString(),
      stemDirection: Stem.UP,
    });

    const noteEntry = new NoteEntry(
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
    noteEntries.push(noteEntry);

    currentNotesArray.push(staveNote);
  }

  // Create tuplets
  const tuplets: TupletRecord[] = [];
  for (const noteEntry of noteEntries) {
    if (noteEntry.numSubDivisions === 3 && noteEntry.subDivisionNum === 0) {
      const beatStartIndex = noteEntries.findIndex((ne) => ne.barNum === noteEntry.barNum);

      const noteRecords = noteEntries.slice(beatStartIndex + noteEntry.index, beatStartIndex + noteEntry.index + 2);
      const tupletNotes = noteRecords.map((noteRecord) => noteRecord.staveNote);
      console.log('Tuplet notes:', noteRecords);
      tuplets.push(
        new TupletRecord(noteEntry.barNum, tupletNotes, {
          numNotes: noteEntry.numSubDivisions,
          notesOccupied: 2,
          bracketed: true,
        })
      );
    }
  }

  return { noteEntries, tuplets };
}

const durationMap: Record<string, number> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  sixteenth: 16,
  thirtysecond: 32,
};

const midiNoteMap: Record<string, number> = {
  'g/5/x': 79, // Example mapping for hihat
  'e/5': 76, // Example mapping for snare
  'g/4': 67, // Example mapping for kick
};

/**
 * Converts the input string into a Beat object with associated BeatNote objects.
 * @param input - The string output to parse.
 * @param authorId - The ID of the user creating the beat.
 * @returns A Beat object with its associated BeatNotes.
 */
export function MakeBeatRecords(input: string, authorId: string): Beat {
  const lines = input.split('\n');
  const beatNotes: BeatNote[] = [];

  lines.forEach((line) => {
    line = line.trim();

    // Detect note
    const staveNoteMatch = line.match(/^note,(\d+),(\d+[t]?),\[(.+)\],(\d+),(\d+),(\d+),(\d+),(\d+)$/);
    if (staveNoteMatch) {
      const index = parseInt(staveNoteMatch[1], 10);
      const duration = durationMap[staveNoteMatch[2]] || 0;
      const keys = staveNoteMatch[3].split(', ').map((key) => {
        if (key === 'hihat') return 'g/5/x';
        if (key === 'snare') return 'e/5';
        if (key === 'kick') return 'g/4';
        console.warn(`Unknown key: ${key}`);
        return 'g/4/x'; // Default to rest
      });
      const barNum = parseInt(staveNoteMatch[4], 10);
      const beatNum = parseInt(staveNoteMatch[5], 10);
      const divisionNum = parseInt(staveNoteMatch[6], 10);
      const subDivisionNum = parseInt(staveNoteMatch[7], 10);
      const numSubDivisions = parseInt(staveNoteMatch[8], 10);

      // Create a BeatNote object for each key
      keys.forEach((key) => {
        const beatNote: BeatNote = {
          id: `${index}-${key}`, // Generate a unique ID (adjust this logic if needed)
          index,
          duration,
          staveNote: midiNoteMap[key] || 0,
          barNum,
          beatNum,
          divisionNum,
          subDivisionNum,
          numSubDivisions,
          velocity: 127, // Default velocity (can be adjusted as needed)
          beatId: '', // This will be set later when the Beat is created
        };
        beatNotes.push(beatNote);
      });
    }
  });

  // Create the Beat object
  const beat: Beat = {
    id: 'beat-1', // Generate a unique ID (adjust this logic if needed)
    authorId, // Use the provided authorId
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes, // Include the associated BeatNotes
  };

  return beat;
}
