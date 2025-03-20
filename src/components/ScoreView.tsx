import { useEffect, useRef } from "react";
import Vex, { Dot, Accidental, Beam, Stem, Renderer, Stave, StaveNote, Voice, Formatter, Articulation, Barline, Modifier, Tuplet } from "vexflow";
import { debugSourceStrings, parseOutputToNotes, TupletRecord } from "./ParseBeat";

function dotted(staveNote: StaveNote) : StaveNote {
  Dot.buildAndAttach([staveNote]);
  return staveNote;
}

const hihat = "g/5/x"
const snare = "e/5"
const kick = "g/4"

export const ScoreView = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    const renderer = new Renderer(containerRef.current, Renderer.Backends.SVG);
    renderer.resize(900, 200);
    const context = renderer.getContext();

    const stave = new Stave(20, 40, 800)
      .addClef('percussion')
      .setTimeSignature('4/4')
      .setBegBarType(Barline.type.REPEAT_BEGIN)
      .setEndBarType(Barline.type.REPEAT_END); 

    stave.setContext(context).draw();

    // Create a voice and format the notes
    stave.addClef('percussion').addTimeSignature('4/4')
    .setBegBarType(Barline.type.REPEAT_BEGIN)
    .setEndBarType(Barline.type.REPEAT_END); 

    const notes1 = [
      new StaveNote({
          keys: [hihat, kick],
          duration: "8",
          stemDirection: Stem.UP,
      }),
      new StaveNote({
          keys: [hihat, kick],
          duration: "16",
          stemDirection: Stem.UP,
      }).setStyle({ fillStyle: "green", strokeStyle: "green" }),
      new StaveNote({
        keys: [kick],
        duration: "16",
        stemDirection: Stem.UP,
      }).setStyle({ fillStyle: "red", strokeStyle: "red" }),
    ];

    const notes2 = [
      new StaveNote({
        keys: [hihat, snare],
        duration: "8",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [hihat],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [snare],
        duration: "16",
        stemDirection: Stem.UP,
      }),
    ];

    const notes3 = [
      new StaveNote({
        keys: [hihat, kick],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [snare],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [snare],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
          keys: [hihat, snare],
          duration: "16",
          stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [kick],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [kick],
        duration: "16",
        stemDirection: Stem.UP,
      }),
    ];
    
    const notes4 = [
      new StaveNote({
        keys: [hihat],
        duration: "16",
        stemDirection: Stem.UP,
      }).setStemLength(40),
      new StaveNote({
        keys: [kick],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [hihat],
        duration: "16",
        stemDirection: Stem.UP,
      }),
      new StaveNote({
        keys: [snare],
        duration: "16",
        stemDirection: Stem.UP,
      }),
    ];

    // const staveNotes = [notes1, notes2, notes3, notes4];
    // const tuplets = [
    //   new Tuplet(notes3.slice(0, 3), { numNotes: 3, notesOccupied: 2, bracketed: true }),
    //   new Tuplet(notes3.slice(3, 6), { numNotes: 3, notesOccupied: 2, bracketed: true })
    // ];

    const hihatStr2 = "h,h,h,h,h,h,h,h";
    const kickStr2 = "k,kk,,,k,xkk,xk,";
    const snareStr2 = ",,s,xs,xss,s,,xs";

    // Example usage
    const debugOutput2 = debugSourceStrings(hihatStr2, kickStr2, snareStr2);
    console.log(debugOutput2);

    const { staveNotes, tuplets } = parseOutputToNotes(debugOutput2);
    if (staveNotes === undefined || tuplets === undefined) {
      console.error("staveNotes or tuplets is undefined");
      return;
    }
    console.log(staveNotes, tuplets);

    const allNotes : StaveNote[] = Object.values(staveNotes).flat() as StaveNote[];
    console.log(allNotes)

    let currentX = 20;
    allNotes.forEach((note) => {
      note.setX(currentX); // Set the x position of the note
      // currentX += spacingPerQuarterNote * (note.getTicks().value() / Vex.Flow.RESOLUTION); // Adjust for note duration
      //  currentX += 40;
    });
    
    // const beams = [new Beam(notes1), new Beam(notes2), new Beam(notes3), new Beam(notes4)];
    console.log(`beams: `, staveNotes[2])
    const beams = staveNotes.map((notesArray) => new Beam(notesArray));

    Formatter.FormatAndDraw(context, stave, allNotes);

    // Draw the beams and stems.
    beams.forEach((b) => {
      b.setContext(context).draw();
    });

    tuplets.forEach((tupletRecord: TupletRecord) => {
      console.log(`draw tuplet: ${tupletRecord.options.numNotes} notes occupying ${tupletRecord.options.notesOccupied}`);
      tupletRecord.tuplet.setContext(context).draw();
    });
  }, []);

  return <div className="h-full w-full" ref={containerRef}>ScoreView</div>;
};


// const hihatStr = "h,h,h,h,h,h,h,h";
// const kickStr = "k,kk,,,k,k,xk,";
// const snareStr = ",,s,xs,xss,,,xs";

// // Example usage
// const debugOutput = debugSourceStrings(hihatStr, kickStr, snareStr);
// console.log(debugOutput);


// const hihatStr2 = "h,h,h,h,h,h,h,h";
// const kickStr2 = "k,kk,,,k,xkk,xk,";
// const snareStr2 = ",,s,xs,xss,s,,xs";

// // Example usage
// const debugOutput2 = debugSourceStrings(hihatStr2, kickStr2, snareStr2);
// console.log(debugOutput2);

// let staveNotes, tuplets = parseOutputToNotes(debugOutput2);
// console.log(staveNotes, tuplets);
