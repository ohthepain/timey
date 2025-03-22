import { useEffect, useRef } from "react";
import { Beam, Renderer, Stave, StaveNote, TickContext, Barline } from "vexflow";
import { ParseBeatString, MakeStaveNotes, TupletRecord } from "./ParseBeat";

export const ScoreView = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    const marginX = 20;
    const width = 700;
    const beatSpace = 10;
    const beatWidth = 104;
    const divisionWidth = 50;

    const renderer = new Renderer(containerRef.current, Renderer.Backends.SVG);
    renderer.resize(width + marginX * 2 + 20, 200);
    const context = renderer.getContext();

    const stave = new Stave(marginX, 40, marginX + width)
      .addClef('percussion')
      .setTimeSignature('4/4')
      .setBegBarType(Barline.type.REPEAT_BEGIN)
      .setEndBarType(Barline.type.REPEAT_END); 

    stave.setContext(context).draw();

    const hihatStr2 = "h,h,h,h,h,h,h,h";
    const kickStr2 = "k,kk,,,k,xkk,xk,";
    const snareStr2 = ",,s,xs,xss,s,,xs";
    const beatString = ParseBeatString(hihatStr2, kickStr2, snareStr2);
    console.log(beatString);

    const { tuplets, noteEntries } = MakeStaveNotes(beatString);
    const allNotes = noteEntries.map((noteEntry) => noteEntry.staveNote);

    // Make a beam for each beat
    const staveNotes : StaveNote[][] = [];
    for (const noteEntry of noteEntries) {
      if (!staveNotes[noteEntry.beatNum]) {
        staveNotes[noteEntry.beatNum] = [];
      }
      staveNotes[noteEntry.beatNum].push(noteEntry.staveNote);
    }
    const beams = staveNotes.map((notesArray) => new Beam(notesArray));

    noteEntries.forEach((noteEntry) => {
      const x = beatSpace 
        // + noteEntry.barNum * barWidth
        + (noteEntry.beatNum - 1) * beatWidth 
        + (noteEntry.divisionNum - 1) * divisionWidth 
        + (noteEntry.subDivisionNum - 1) / (noteEntry.numSubDivisions + 1) * divisionWidth

      const note = noteEntry.staveNote;
      const tickContext = new TickContext();
      tickContext.addTickable(note);
      tickContext.preFormat().setX(x);
      note.setTickContext(tickContext);
      note.setStave(stave);
    });

    // Formatter.FormatAndDraw(context, stave, allNotes);
    allNotes.forEach((note) => {
      note.setStave(stave);
      note.setContext(context).draw();
    });

    // Draw beams and stems
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
