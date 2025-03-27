import { Stem, StaveNote, Tuplet } from "vexflow";

const hihat = "g/5/x";
const snare = "e/5";
const kick = "g/4";

export function ParseBeatStrings(hihatStr: string[], kickStr: string[], snareStr: string[]): string {
  let result = "";
  for (let barNum = 0; barNum < hihatStr.length; barNum++) {
    result += ParseBarStrings(barNum, hihatStr[barNum], kickStr[barNum], snareStr[barNum]);
    result += "\n";
  }
  return result;
}

/**
 * Converts the source strings into a readable string format that represents each StaveNote.
 * @param hihatStr - String representing hi-hat beats.
 * @param kickStr - String representing kick beats.
 * @param snareStr - String representing snare beats.
 * @returns A readable string format of the notes.
 */
export function ParseBarStrings(barNum: number, hihatStr: string, kickStr: string, snareStr: string): string {
  const hihatBeats = hihatStr.split(",");
  const kickBeats = kickStr.split(",");
  const snareBeats = snareStr.split(",");

  const result: string[] = ["// note,index,duration,keys,barNum,beatNum,divisionNum,subDivisionNum,numSubDivisions"];
  const tuples: string[] = ["// tuple,barNum,beatNum,startIndex,numNotes"];
  let noteIndex = 1;
  let notesThisQuarterNote = 0;
  let beatNumber = -1;
  let divisionNumber = -1;

  result.push(`bar,${barNum}`);

  for (let i = 0; i < hihatBeats.length; i++) {
    const hihat = hihatBeats[i] || "";
    const kick = kickBeats[i] || "";
    const snare = snareBeats[i] || "";

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
    if (hihat.length === 3 || kick.length === 3 || snare.length === 3) {
      // Triplet case
      tuples.push(`tuple,${barNum},${quarterNoteIndex},${notesThisQuarterNote},3`);
      for (let j = 0; j < 3; j++) {
        const keys: string[] = [];
        if (hihat[j] === "h") keys.push("hihat");
        if (kick[j] === "k") keys.push("kick");
        if (snare[j] === "s") keys.push("snare");
        if (keys.length === 0) keys.push("rest");

        result.push(`note,${noteIndex++},16,[${keys.join(", ")}],${barNum},${beatNumber},${divisionNumber},${j},3`);
        ++notesThisQuarterNote;
      }
    } else if (hihat.length === 2 || kick.length === 2 || snare.length === 2) {
      // Two 16th notes
      for (let j = 0; j < 2; j++) {
        const keys: string[] = [];
        if (hihat[j] === "h") keys.push("hihat");
        if (kick[j] === "k") keys.push("kick");
        if (snare[j] === "s") keys.push("snare");
        if (keys.length === 0) keys.push("rest");

        result.push(`note,${noteIndex++},16,[${keys.join(", ")}],${barNum},${beatNumber},${divisionNumber},${j},2`);
        ++notesThisQuarterNote;
      }
    } else {
      // Single 8th note
      const keys: string[] = [];
      if (hihat.includes("h")) keys.push("hihat");
      if (kick.includes("k")) keys.push("kick");
      if (snare.includes("s")) keys.push("snare");
      if (keys.length === 0) keys.push("rest");

      result.push(`note,${noteIndex++},8,[${keys.join(", ")}],${barNum},${beatNumber},${divisionNumber},0,1`);
      ++notesThisQuarterNote;
    }
  }

  return [...result, ...tuples].join("\n");
}

export class TupletRecord {
  barNum: number;
  notes: StaveNote[];
  options: { numNotes: number; notesOccupied: number; bracketed: boolean };
  tuplet: Tuplet;

  constructor(barNum: number, notes: StaveNote[], options: { numNotes: number; notesOccupied: number; bracketed: true }) {
    this.barNum = barNum;
    this.notes = notes;
    this.options = options;
    this.tuplet = new Tuplet(this.notes, this.options);
  }
}

export class NoteEntry {
  keys: string[];
  durationCode: string;
  staveNote: StaveNote;
  barNum: number;
  beatNum: number;
  divisionNum: number;
  subDivisionNum: number;
  numSubDivisions: number;

  constructor(keys: string[], durationCode: string, staveNote: StaveNote, barNum: number, beatNum: number, divisionNum: number, subDivisionNum: number, numSubDivisions: number) {
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

/**
 * Converts the output string into arrays of StaveNote objects and Tuplet objects.
 * @param input - The string output to parse.
 * @returns An object containing the notes arrays and tuplets.
 */
export function MakeStaveNotes(input: string) : { noteEntries: NoteEntry[], tuplets: TupletRecord[] } {
  const lines = input.split("\n");
  const tuplets: TupletRecord[] = [];
  const noteEntries: NoteEntry[] = [];

  let currentNotesArray: StaveNote[] | null = null;

  lines.forEach((line) => {
    line = line.trim();

    // Detect beat
    const notesMatch = line.match(/^beat,(\d+)$/);
    if (notesMatch) {
      currentNotesArray = [];
      return;
    }

    // Detect note
    const staveNoteMatch = line.match(/^note,\d+,(\d+[t]?),\[(.+)\],(\d+),(\d+),(\d+),(\d+),(\d+)$/);
    if (staveNoteMatch && currentNotesArray) {
      const duration = staveNoteMatch[1];
      const keys = staveNoteMatch[2].split(", ").map((key) => {
        if (key === "hihat") return hihat;
        if (key === "snare") return snare;
        if (key === "kick") return kick;
        console.warn(`Unknown key: ${key}`);
        return "g/4/x"; // Default to rest
      });
      const barNum = parseInt(staveNoteMatch[3], 10);
      const beatNum = parseInt(staveNoteMatch[4], 10);
      const divisionNum = parseInt(staveNoteMatch[5], 10);
      const subDivisionNum = parseInt(staveNoteMatch[6], 10);
      const numSubDivisions = parseInt(staveNoteMatch[7], 10);

      const staveNote = new StaveNote({
        keys,
        duration,
        stemDirection: Stem.UP,
      });

      const noteEntry = new NoteEntry(keys, duration, staveNote, barNum, beatNum, divisionNum, subDivisionNum, numSubDivisions);
      noteEntries.push(noteEntry);

      currentNotesArray.push(staveNote);
      return;
    }

    // Detect Tuplet (e.g., "tuple notes2,0,3:")
    const tupletMatch = line.match(/^tuple,(\d+),(\d+),(\d+),(\d+)$/);
    if (tupletMatch) {
      const barNum = parseInt(tupletMatch[1], 10);
      console.log(`barNum: ${barNum}`);
      const beatNum = parseInt(tupletMatch[2], 10);
      const startIndex = parseInt(tupletMatch[3], 10);
      const numNotes = parseInt(tupletMatch[4], 10);

      // Find first note in beat
      const beatStartIndex = noteEntries.findIndex((noteEntry) => noteEntry.beatNum === beatNum && noteEntry.barNum === barNum);
      console.log(`beatStartIndex: ${beatStartIndex}`);

      const noteRecords = noteEntries.slice(beatStartIndex + startIndex, beatStartIndex + startIndex + numNotes);
      for (let i = 0; i < noteRecords.length; i++) {
        console.log(`noteRecords: bar ${noteRecords[i].barNum} beat ${noteRecords[i].beatNum} division  ${noteRecords[i].divisionNum}`);
      }
      const tupletNotes = noteRecords.map((noteRecord) => noteRecord.staveNote);
      tuplets.push(new TupletRecord(barNum, tupletNotes, { numNotes, notesOccupied: 2, bracketed: true }));
    }
  });

  return { noteEntries, tuplets };
}
