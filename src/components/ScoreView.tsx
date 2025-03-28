import { useEffect, useRef } from 'react';
import { Beam, Renderer, Stave, StaveNote, TickContext, Tickable, Barline, RenderContext, drawDot } from 'vexflow';
import { ParseBeatStrings, MakeStaveNotes, TupletRecord } from './ParseBeat';
import TempoService from '~/lib/MidiSync/TempoService';
import { useScoreStore } from '~/state/ScoreStore';

const plotMetricsForNote = (ctx: RenderContext, note: Tickable, yPos: number): void => {
  const xStart = note.getAbsoluteX();
  const xEnd = xStart + 10; //(note.getFormatterMetrics().freedom.right || 0);

  const xWidth = xEnd - xStart;
  ctx.save();
  ctx.setFont('Arial', 8);
  ctx.fillText(Math.round(xWidth) + 'px', xStart + note.getXShift(), yPos);

  const y = yPos + 7;
  function stroke(x1: number, x2: number, color: string, yy: number = y) {
    ctx.beginPath();
    ctx.setStrokeStyle(color);
    ctx.setFillStyle(color);
    ctx.setLineWidth(3);
    ctx.moveTo(x1 + note.getXShift(), yy);
    ctx.lineTo(x2 + note.getXShift(), yy);
    ctx.stroke();
  }

  stroke(xStart, xEnd, 'red');
  stroke(xStart - note.getXShift(), xStart, '#BBB'); // Shift
  drawDot(ctx, xStart + note.getXShift(), y, 'blue');

  // Not sure if this is required
  ctx.restore();
};

/**
 * @param ctx
 * @param x
 * @param y
 */
const plotLegendForNoteWidth = (ctx: RenderContext, x: number, y: number) => {
  ctx.save();
  ctx.setFont('arial', 8);

  const spacing = 12;
  let lastY = y;

  function legend(color: string, text: string) {
    ctx.beginPath();
    ctx.setStrokeStyle(color);
    ctx.setFillStyle(color);
    ctx.setLineWidth(10);
    ctx.moveTo(x, lastY - 4);
    ctx.lineTo(x + 10, lastY - 4);
    ctx.stroke();

    ctx.setFillStyle('black');
    ctx.fillText(text, x + 15, lastY);
    lastY += spacing;
  }

  legend('green', 'Note + Flag');
  legend('red', 'Modifiers');
  legend('#999', 'Displaced Head');
  legend('#DDD', 'Formatter Shift');

  ctx.restore();
};

export const ScoreView = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  let context: any;

  const beatString = useScoreStore((state) => state.getBeat('basic'));
  if (!beatString) {
    return <>Beat not found</>;
  }
  // console.log('beatString', beatString);

  const { tuplets, noteEntries } = MakeStaveNotes(beatString);
  const allNotes: StaveNote[] = noteEntries.map((noteEntry) => noteEntry.staveNote);

  const numBars = Math.max(...noteEntries.map((noteEntry) => noteEntry.barNum)) + 1;

  const marginX = 20;
  const beatSpace = 10;
  const barWidth = 440;
  const width = marginX + barWidth * numBars + marginX;
  const beatWidth = 104;
  const divisionWidth = 50;

  const draw = () => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ''; // Clear previous rendering

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
    const beatNotes: StaveNote[][] = [];
    for (const noteEntry of noteEntries) {
      const i = noteEntry.beatNum + noteEntry.barNum * 100;
      if (!beatNotes[i]) {
        beatNotes[i] = [];
      }
      beatNotes[i].push(noteEntry.staveNote);
    }

    // Make beams
    const beams = beatNotes.map((notesArray) => new Beam(notesArray));

    // Notes and bar lines
    const barLines: Barline[] = [];
    let barNum = 0;
    noteEntries.forEach((noteEntry) => {
      if (noteEntry.barNum > barNum) {
        barNum = noteEntry.barNum;
        const barLine = new Barline(Barline.type.SINGLE);
        barLine.setStave(stave);
        const x = beatSpace + noteEntry.barNum * barWidth + 72; // BUG: Bar lines drawn at wrong position. Same x as notes = rendered in different x position
        barLine.setX(x);
        barLines.push(barLine);
      }

      const x =
        beatSpace +
        noteEntry.barNum * barWidth +
        noteEntry.beatNum * beatWidth +
        noteEntry.divisionNum * divisionWidth +
        (noteEntry.subDivisionNum / (noteEntry.numSubDivisions + 1)) * divisionWidth;

      const note = noteEntry.staveNote;
      const tickContext = new TickContext();
      tickContext.addTickable(note);
      // console.log(
      //   `noteEntry: ${noteEntry.barNum} ${noteEntry.beatNum} ${noteEntry.divisionNum} at x: ${x}`
      // );
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
      tupletRecord.tuplet.setContext(context).draw();
    });

    allNotes.forEach((note) => {
      plotMetricsForNote(context, note, 10);
    });

    plotLegendForNoteWidth(context, barWidth * 2, 150);
  };

  let pulseNum = 0;
  let x = 0;
  const handleMidiPulse = (e: any) => {
    if (x++ < 10) return;
    x = 0;
    // const notesToUpdate = allNotes.filter((note, index) => index === pulseNum++ % allNotes.length); // Example logic
    const notesToUpdate = [allNotes[pulseNum++ % allNotes.length]];

    notesToUpdate.forEach((note) => {
      const noteElement = document.querySelector(`[data-id="${note.getAttribute('id')}"]`);
      if (noteElement) {
        noteElement.remove();
      }

      note.setStyle({ fillStyle: 'blue', strokeStyle: 'blue' }); // Example: Change color
      note.setContext(context).draw();
    });
  };

  useEffect(() => {
    draw();
    TempoService.eventsEmitter.addListener('MIDI pulse', handleMidiPulse);
    return () => {
      TempoService.eventsEmitter.removeListener('MIDI pulse', handleMidiPulse);
    };
  }, []);

  return (
    <div className="h-full w-full" ref={containerRef}>
      ScoreView
    </div>
  );
};
