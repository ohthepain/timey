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
        if (hihat[j] === "h") keys.push("Hi-Hat");
        if (kick[j] === "k") keys.push("Kick");
        if (snare[j] === "s") keys.push("Snare");
        if (keys.length === 0) keys.push("Rest");

        result.push(`StaveNote ${staveNoteIndex++}: Duration = 8t, Keys = [${keys.join(", ")}]`);
        ++notesThisQuarterNote;
      }
    } else if (hihat.length === 2 || kick.length === 2 || snare.length === 2) {
      // Two 16th notes
      for (let j = 0; j < 2; j++) {
        const keys: string[] = [];
        if (hihat[j] === "h") keys.push("Hi-Hat");
        if (kick[j] === "k") keys.push("Kick");
        if (snare[j] === "s") keys.push("Snare");
        if (keys.length === 0) keys.push("Rest");

        result.push(`StaveNote ${staveNoteIndex++}: Duration = 16, Keys = [${keys.join(", ")}]`);
        ++notesThisQuarterNote;
      }
    } else {
      // Single 8th note
      const keys: string[] = [];
      if (hihat.includes("h")) keys.push("Hi-Hat");
      if (kick.includes("k")) keys.push("Kick");
      if (snare.includes("s")) keys.push("Snare");
      if (keys.length === 0) keys.push("Rest");

      result.push(`StaveNote ${staveNoteIndex++}: Duration = 8, Keys = [${keys.join(", ")}]`);
      ++notesThisQuarterNote;
    }
  }

  return [...result, ...tuples].join("\n");
}
