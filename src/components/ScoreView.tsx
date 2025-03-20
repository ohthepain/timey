import { useEffect, useRef } from "react";
import { Beam, Stem, Renderer, Stave, StaveNote, Formatter, Barline } from "vexflow";
import { ParseBeatString, parseOutputToNotes, TupletRecord } from "./ParseBeat";

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

    const hihatStr2 = "h,h,h,h,h,h,h,h";
    const kickStr2 = "k,kk,,,k,xkk,xk,";
    const snareStr2 = ",,s,xs,xss,s,,xs";

    // Example usage
    const debugOutput2 = ParseBeatString(hihatStr2, kickStr2, snareStr2);
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
