import { StaveNote, Stem, Tuplet } from "vexflow";

const hihat = "g/5/x";
const snare = "e/5";
const kick = "g/4";

/**
 * Transforms beat strings into arrays of StaveNote objects.
 * @param hihatStr - String representing hi-hat beats.
 * @param kickStr - String representing kick beats.
 * @param snareStr - String representing snare beats.
 * @returns Array of StaveNote objects.
 */
export function ParseBeat(hihatStr: string, kickStr: string, snareStr: string): (StaveNote | Tuplet)[] {
  const beats = hihatStr.split(",").map((_, index) => ({
    hihat: hihatStr.split(",")[index] || "",
    kick: kickStr.split(",")[index] || "",
    snare: snareStr.split(",")[index] || "",
  }));

  const staveNotes: (StaveNote | Tuplet)[] = [];

  beats.forEach((beat) => {
    const keys: string[] = [];
    let duration = "16"; // Default to 16th note

    // Determine the duration based on the beat string
    if (beat.hihat.length === 3 || beat.kick.length === 3 || beat.snare.length === 3) {
      // Handle triplets
      const tripletNotes: StaveNote[] = [];
      for (let i = 0; i < 3; i++) {
        const tripletKeys: string[] = [];
        if (beat.hihat[i] === "h") tripletKeys.push(hihat);
        if (beat.kick[i] === "k") tripletKeys.push(kick);
        if (beat.snare[i] === "s") tripletKeys.push(snare);
        if (tripletKeys.length === 0) tripletKeys.push("g/4/x"); // Add rest if no keys

        tripletNotes.push(
          new StaveNote({
            keys: tripletKeys,
            duration: "8", // Each note in the triplet is an 8th note
            stemDirection: Stem.UP,
          })
        );
      }
      staveNotes.push(new Tuplet(tripletNotes)); // Add the triplet as a Tuplet object
      return;
    } else if (beat.hihat.length === 2 || beat.kick.length === 2 || beat.snare.length === 2) {
      duration = "16"; // Two 16th notes
    } else if (beat.hihat.length === 1 || beat.kick.length === 1 || beat.snare.length === 1) {
      duration = "8"; // Single 8th note
    }

    // Add hi-hat to keys if present
    if (beat.hihat.includes("h")) {
      keys.push(hihat);
    }

    // Add kick to keys if present
    if (beat.kick.includes("k")) {
      keys.push(kick);
    }

    // Add snare to keys if present
    if (beat.snare.includes("s")) {
      keys.push(snare);
    }

    // Add a rest if no keys are present
    if (keys.length === 0) {
      keys.push("g/4/x"); // Rest
    }

    // Create a StaveNote and add it to the array
    staveNotes.push(
      new StaveNote({
        keys,
        duration,
        stemDirection: Stem.UP,
      })
    );
  });

  return staveNotes;
}

// Example usage
// const hihatStr = "h,h,h,h,h,h,h,h";
// const kickStr = "kk,,,,,xk,xkk,xkk,k";
// const snareStr = ",,s,xs,,ss,s,s";

// const allNotes = ParseBeat(hihatStr, kickStr, snareStr);
// console.log(allNotes);