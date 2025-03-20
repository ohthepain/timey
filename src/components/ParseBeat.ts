import { Stem, StaveNote, Tuplet } from "vexflow";

const hihat = "g/5/x";
const snare = "e/5";
const kick = "g/4";

/**
 * Converts the source strings into a readable string format that represents each StaveNote.
 * @param hihatStr - String representing hi-hat beats.
 * @param kickStr - String representing kick beats.
 * @param snareStr - String representing snare beats.
 * @returns A readable string format of the notes.
 */
export function debugSourceStrings(hihatStr: string, kickStr: string, snareStr: string): string {
  const hihatBeats = hihatStr.split(",");
  const kickBeats = kickStr.split(",");
  const snareBeats = snareStr.split(",");

  const result: string[] = [];
  const tuples: string[] = [];
  let staveNoteIndex = 1; // Index for StaveNotes
  let notesThisQuarterNote = 0; // Number of notes in the current quarter note

  for (let i = 0; i < hihatBeats.length; i++) {
    const hihat = hihatBeats[i] || "";
    const kick = kickBeats[i] || "";
    const snare = snareBeats[i] || "";

    // Determine the quarter note label
    const quarterNoteIndex = Math.floor(i / 2);
    if (i % 2 === 0) {
      notesThisQuarterNote = 0;
      result.push(`notes${quarterNoteIndex}:`);
    }

    // Process each 8th note
    if (hihat.length === 3 || kick.length === 3 || snare.length === 3) {
      // Triplet case
      tuples.push(`tuple notes${quarterNoteIndex},${notesThisQuarterNote},3:`);
      for (let j = 0; j < 3; j++) {
        const keys: string[] = [];
        if (hihat[j] === "h") keys.push("hihat");
        if (kick[j] === "k") keys.push("kick");
        if (snare[j] === "s") keys.push("snare");
        if (keys.length === 0) keys.push("rest");

        result.push(`StaveNote ${staveNoteIndex++}: Duration = 16, Keys = [${keys.join(", ")}]`);
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

        result.push(`StaveNote ${staveNoteIndex++}: Duration = 16, Keys = [${keys.join(", ")}]`);
        ++notesThisQuarterNote;
      }
    } else {
      // Single 8th note
      const keys: string[] = [];
      if (hihat.includes("h")) keys.push("hihat");
      if (kick.includes("k")) keys.push("kick");
      if (snare.includes("s")) keys.push("snare");
      if (keys.length === 0) keys.push("rest");

      result.push(`StaveNote ${staveNoteIndex++}: Duration = 8, Keys = [${keys.join(", ")}]`);
      ++notesThisQuarterNote;
    }
  }

  return [...result, ...tuples].join("\n");
}

export class TupletRecord {
  notes: StaveNote[];
  options: { numNotes: number; notesOccupied: number; bracketed: boolean };
  tuplet: Tuplet;

  constructor(notes: StaveNote[], options: { numNotes: number; notesOccupied: number; bracketed: true }) {
    this.notes = notes;
    this.options = options;
    this.tuplet = new Tuplet(this.notes, this.options);
  }
}

/**
 * Converts the output string into arrays of StaveNote objects and Tuplet objects.
 * @param output - The string output to parse.
 * @returns An object containing the notes arrays and tuplets.
 */
export function parseOutputToNotes(output: string) : { staveNotes: StaveNote[][]; tuplets: TupletRecord[] } {
  const lines = output.split("\n");
  const staveNotes: StaveNote[][] = [];
  const tuplets: TupletRecord[] = [];

  let currentNotesArray: StaveNote[] | null = null;

  lines.forEach((line) => {
    line = line.trim();

    // Detect notes array (e.g., "notes1:")
    const notesMatch = line.match(/^notes(\d+):$/);
    if (notesMatch) {
      currentNotesArray = [];
      staveNotes.push(currentNotesArray);
      return;
    }

    // Detect StaveNote (e.g., "StaveNote 1: Duration = 8, Keys = [Hi-Hat, Kick]")
    const staveNoteMatch = line.match(/^StaveNote \d+: Duration = (\d+[t]?), Keys = \[(.+)\]$/);
    if (staveNoteMatch && currentNotesArray) {
      const duration = staveNoteMatch[1];
      const keys = staveNoteMatch[2].split(", ").map((key) => {
        if (key === "hihat") return hihat;
        if (key === "snare") return snare;
        if (key === "kick") return kick;
        console.warn(`Unknown key: ${key}`);
        return "g/4/x"; // Default to rest
      });

      const staveNote = new StaveNote({
        keys,
        duration,
        stemDirection: Stem.UP,
      });

      currentNotesArray.push(staveNote);
      return;
    }

    // Detect Tuplet (e.g., "tuple notes2,0,3:")
    const tupletMatch = line.match(/^tuple notes(\d+),(\d+),(\d+):$/);
    if (tupletMatch) {
      const notesIndex = parseInt(tupletMatch[1], 10);
      const startIndex = parseInt(tupletMatch[2], 10);
      const numNotes = parseInt(tupletMatch[3], 10);

      if (staveNotes[notesIndex]) {
        const tupletNotes = staveNotes[notesIndex].slice(startIndex, startIndex + numNotes);
        tuplets.push(new TupletRecord(tupletNotes, { numNotes, notesOccupied: 2, bracketed: true }));
      }
    }
  });

  // const beams = staveNotes.map((notesArray) => new Beam(notesArray));

  console.log(staveNotes, tuplets);
  return { staveNotes, tuplets };
}
