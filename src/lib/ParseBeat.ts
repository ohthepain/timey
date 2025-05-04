import { Stem, StaveNote, Tuplet } from 'vexflow';
import { BarSource, BeatSource } from '~/types/BarSource';
import { Beat } from '~/types/Beat';

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
        console.log(
          `note: ${index} ${durationCode} ${keysString} bar ${bar} beat ${beat} div ${divisionNum} sub ${subDivisionNum} of ${numSubDivisions}`
        );

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
    result += ParseBarSource(barNum, [bar.kick, bar.hihat, bar.snare, bar.accent]);
    result += '\n';
  }

  console.log(`ParseBeatStrings: ${result}`);
  return result;
}

/**
 * Converts the source strings into a readable string format that represents each StaveNote.
 * @returns A readable string format of the notes.
 */
export function ParseBarSource(barNum: number, beatStrings: string[]): string {
  const beatArrays = beatStrings.map((beatStr) => beatStr.split(','));

  const result: string[] = ['// note,index,duration,keys,barNum,beatNum,divisionNum,subDivisionNum,numSubDivisions'];
  const tuples: string[] = ['// tuple,barNum,beatNum,startIndex,numNotes'];
  let noteIndex = 0;
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
      if (key === 'rest') return 'g/4/x';
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
      // console.log('Tuplet notes:', noteRecords);
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

export function createBeatSourceFromBeat(beat: Beat): BeatSource {
  console.log('createBeatSourceFromBeat', beat);
  const barsMap = new Map<number, BarSource>();

  let subdivisionNum = 0;

  for (let i = 0; i < beat.beatNotes.length; i++) {
    const note = beat.beatNotes[i];
    console.log('subdivisionNum', subdivisionNum, note.subDivisionNum, note.numSubDivisions);
    if (subdivisionNum === 0) {
      subdivisionNum = note.numSubDivisions;
    }
    --subdivisionNum;

    const bar = barsMap.get(note.barNum) || { kick: '', hihat: '', snare: '', accent: '' };
    // Parse noteString to determine which voices are present
    const voices = note.noteString.split(',').map((s) => s.trim());
    if (voices.includes('kick')) {
      bar.kick += 'k';
    } else {
      bar.kick += 'x';
    }
    if (voices.includes('hihat')) {
      bar.hihat += 'h';
    } else {
      bar.hihat += 'x';
    }
    if (voices.includes('snare')) {
      bar.snare += 's';
    } else {
      bar.snare += 'x';
    }
    if (voices.includes('accent')) {
      bar.accent += 'a';
    } else {
      bar.accent += 'x';
    }

    if (subdivisionNum === 0) {
      // remove any trailing x's from the end of the string
      bar.kick = bar.kick.replace(/x+$/, '');
      bar.hihat = bar.hihat.replace(/x+$/, '');
      bar.snare = bar.snare.replace(/x+$/, '');
      bar.accent = bar.accent.replace(/x+$/, '');

      if (i < beat.beatNotes.length - 1) {
        // Add a comma if not the last note
        bar.kick += ',';
        bar.hihat += ',';
        bar.snare += ',';
        bar.accent += ',';
      }
    }

    // Accent is not always present, but you can add logic if needed
    barsMap.set(note.barNum, bar);
  }

  // Remove trailing comma from kick, hihat, snare and accent for all bars
  for (const [, bar] of barsMap.entries()) {
    bar.kick = bar.kick.replace(/,$/, '');
    bar.hihat = bar.hihat.replace(/,$/, '');
    bar.snare = bar.snare.replace(/,$/, '');
    bar.accent = bar.accent.replace(/,$/, '');
  }

  // Convert map to array, sorted by barNum
  const bars: BarSource[] = Array.from(barsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, bar]) => bar);

  return new BeatSource(bars);
}
