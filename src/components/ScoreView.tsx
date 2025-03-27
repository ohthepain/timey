import { useEffect, useRef } from "react";
import { Beam, Renderer, Stave, StaveNote, TickContext, Barline } from "vexflow";
import { ParseBeatStrings, MakeStaveNotes, TupletRecord } from "./ParseBeat";
import TempoService from "~/lib/MidiSync/TempoService";

export const ScoreView = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  var allNotes: StaveNote[] = [];
  var context: any;

  const draw = () => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    const hihatStr = "h,h,h,h,h,h,h,h";
    const kickStr = "k,,,,k,,,";
    const snareStr = ",,s,,,,s,";
    const kickStr1 = "k,kk,,,k,xkk,xk,";
    const snareStr1 = ",,s,xs,xss,s,,xs";
    // const beatString = ParseBeatStrings([hihatStr], [kickStr], [snareStr]);
    // const beatString = ParseBeatStrings([hihatStr,hihatStr], [kickStr,kickStr], [snareStr,snareStr]);
    const beatString = ParseBeatStrings([hihatStr,hihatStr], [kickStr,kickStr1], [snareStr,snareStr1]);
    console.log(beatString);

    const { tuplets, noteEntries } = MakeStaveNotes(beatString);
    allNotes = noteEntries.map((noteEntry) => noteEntry.staveNote);

    const numBars = Math.max(...noteEntries.map((noteEntry) => noteEntry.barNum)) + 1;
    console.log(`numBars: ${numBars}`);

    const marginX = 20;
    const beatSpace = 10;
    const barWidth = 440;
    const width = marginX + barWidth * numBars + marginX;
    const beatWidth = 104;
    const divisionWidth = 50;

    const renderer = new Renderer(containerRef.current, Renderer.Backends.SVG);
    renderer.resize(width + marginX * 2 + 20, 200);
    context = renderer.getContext();

    const stave = new Stave(marginX, 40, marginX + width)
      .addClef('percussion')
      .setTimeSignature('4/4')
      .setBegBarType(Barline.type.REPEAT_BEGIN)
      .setEndBarType(Barline.type.REPEAT_END); 

    stave.setContext(context).draw();

    // Beams: Make a set of notes for each beam - one beat per beat
    const beatNotes : StaveNote[][] = [];
    for (const noteEntry of noteEntries) {
      const i =  noteEntry.beatNum + noteEntry.barNum * 100
      if (!beatNotes[i]) {
        beatNotes[i] = [];
      }
      beatNotes[i].push(noteEntry.staveNote);
    }

    // Make beams
    const beams = beatNotes.map((notesArray) => new Beam(notesArray));

    // Notes and bar lines
    const barLines : Barline[] = [];
    let barNum = 0;
    noteEntries.forEach((noteEntry) => {
      if (noteEntry.barNum > barNum) {
        barNum = noteEntry.barNum;
        console.log(`draw bar ${barNum}`);
        const barLine = new Barline(Barline.type.SINGLE);
        barLine.setStave(stave);
        const x = beatSpace + noteEntry.barNum * barWidth
        + 72; // BUG: Bar lines drawn at wrong position. Same x as notes = rendered in different x position
        barLine.setX(x);
        barLines.push(barLine);
        console.log(`draw bar ${barNum} at x: ${x}`);
      }
  
      const x = beatSpace 
        + noteEntry.barNum * barWidth
        + (noteEntry.beatNum) * beatWidth 
        + (noteEntry.divisionNum) * divisionWidth 
        + (noteEntry.subDivisionNum) / (noteEntry.numSubDivisions + 1) * divisionWidth

      const note = noteEntry.staveNote;
      const tickContext = new TickContext();
      tickContext.addTickable(note);
      console.log(`noteEntry: ${noteEntry.barNum} ${noteEntry.beatNum} ${noteEntry.divisionNum} at x: ${x}`);
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

    barLines.forEach((barLine) => {
      barLine.setContext(context).draw();
    });

    tuplets.forEach((tupletRecord: TupletRecord) => {
      console.log(`draw tuplet: ${tupletRecord.options.numNotes} notes occupying ${tupletRecord.options.notesOccupied}`);
      tupletRecord.tuplet.setContext(context).draw();
    });
  }

  let pulseNum = 0;
  let x = 0;
  const handleMidiPulse = (e:any) => {
    if (x++ < 10) return;
    x = 0;
    // const notesToUpdate = allNotes.filter((note, index) => index === pulseNum++ % allNotes.length); // Example logic
    const notesToUpdate = [allNotes[pulseNum++ % allNotes.length]];

    notesToUpdate.forEach((note) => {
      const noteElement = document.querySelector(`[data-id="${note.getAttribute('id')}"]`);
      if (noteElement) {
        noteElement.remove();
      }
  
      note.setStyle({ fillStyle: "blue", strokeStyle: "blue" }); // Example: Change color
      note.setContext(context).draw();
    });
  }

  useEffect(() => {
    draw();
    TempoService.eventsEmitter.addListener('MIDI pulse', handleMidiPulse)
    return () => {
      TempoService.eventsEmitter.removeListener('MIDI pulse', handleMidiPulse)
  }

  }, []);

  return <div className="h-full w-full" ref={containerRef}>ScoreView</div>;
};
