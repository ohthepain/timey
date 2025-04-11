import { useEffect, useRef, useState } from 'react';
import { Beam, Renderer, Stave, StaveNote, TickContext, Tickable, Barline, RenderContext, drawDot } from 'vexflow';
import { MakeStaveNotesFromBeat, TupletRecord } from '../lib/ParseBeat';
import { useScoreStore } from '~/state/ScoreStore';
import { useBeatPlayer } from '~/lib/UseBeatPlayer';
import { beatPlayer } from '~/lib/BeatPlayer';
import { NoteEntry } from '~/lib/ParseBeat';
import { getBeatByName } from '~/services/beatService';
import { Beat } from '~/types/Beat';

const marginX = 20;
const beatSpace = 10;
const barWidth = 440;
const beatWidth = 104;
const divisionWidth = 50;

const getNoteEntryX = (noteEntry: NoteEntry) => {
  const x =
    beatSpace +
    noteEntry.barNum * barWidth +
    noteEntry.beatNum * beatWidth +
    noteEntry.divisionNum * divisionWidth +
    (noteEntry.subDivisionNum / (noteEntry.numSubDivisions + 1)) * divisionWidth;
  return x;
};

function stroke(ctx: RenderContext, x1: number, x2: number, y: number, color: string) {
  ctx.beginPath();
  ctx.setStrokeStyle(color);
  ctx.setFillStyle(color);
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

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

const showNoteBar = (ctx: RenderContext, allNotes: NoteEntry[], noteNum: number, y: number): void => {
  console.log(`showNoteBar ${noteNum}/${allNotes.length}`);
  const noteEntry = allNotes[noteNum];
  const staveNote = noteEntry.staveNote;

  // Draw line full width of beat
  ctx.save();
  const numBars = Math.max(...allNotes.map((noteEntry) => noteEntry.barNum)) + 1;
  const width = marginX + barWidth * numBars + marginX;
  ctx.setLineWidth(7);
  stroke(ctx, marginX, marginX + width, y, 'red');

  // Draw line width of note
  let noteEndX;
  if (noteNum >= allNotes.length - 1) {
    noteEndX = marginX + barWidth * numBars;
  } else {
    const nextNoteEntry = allNotes[noteNum + 1];
    const nextStaveNote = nextNoteEntry.staveNote;
    noteEndX = nextStaveNote.getAbsoluteX();
  }

  const noteX = staveNote.getAbsoluteX();
  ctx.setLineWidth(7);
  stroke(ctx, noteX, noteEndX, y, 'green');
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

interface ScoreViewProps {
  beat: Beat;
}

export const ScoreView = ({ beat }: ScoreViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  let context: any;

  const { currentNote } = useBeatPlayer();
  const [currentNoteIndex, setCurrentNoteIndex] = useState<number>(0);

  const beatString = useScoreStore((state) => state.getBeat('basic'));
  if (!beatString) {
    return <>Beat not found</>;
  }
  console.log('beatString', beatString);

  // const { tuplets: tuplets2, noteEntries: noteEntries2 } = MakeStaveNotes(beatString);
  const { tuplets, noteEntries } = MakeStaveNotesFromBeat(beat);
  // console.log(`Lets compare ${noteEntries.length} ${noteEntries2.length}`);
  // console.log('noteEntries', noteEntries);
  // console.log('noteEntries2', noteEntries2);

  // if (noteEntries.length !== noteEntries2.length) {
  //   console.log('The arrays have different lengths.');
  // } else {
  //   for (let i = 0; i < noteEntries.length; i++) {
  //     const entry1 = noteEntries[i];
  //     const entry2 = noteEntries2[i];

  //     if (
  //       entry1.index !== entry2.index ||
  //       entry1.keys.join(',') !== entry2.keys.join(',') ||
  //       entry1.durationCode !== entry2.durationCode ||
  //       entry1.barNum !== entry2.barNum ||
  //       entry1.beatNum !== entry2.beatNum ||
  //       entry1.divisionNum !== entry2.divisionNum ||
  //       entry1.subDivisionNum !== entry2.subDivisionNum ||
  //       entry1.numSubDivisions !== entry2.numSubDivisions
  //     ) {
  //       console.log(`Difference found at index ${i}:`, { entry1, entry2 });
  //     }
  //   }
  //   console.log('Comparison complete.');
  // }

  const allNotes: NoteEntry[] = noteEntries.map((noteEntry) => noteEntry);

  const numBars = Math.max(...noteEntries.map((noteEntry) => noteEntry.barNum)) + 1;

  const width = marginX + barWidth * numBars + marginX;

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

      // const x =
      //   beatSpace +
      //   noteEntry.barNum * barWidth +
      //   noteEntry.beatNum * beatWidth +
      //   noteEntry.divisionNum * divisionWidth +
      //   (noteEntry.subDivisionNum / (noteEntry.numSubDivisions + 1)) * divisionWidth;
      const x = getNoteEntryX(noteEntry);

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

    allNotes.forEach((note) => {
      note.staveNote.setStave(stave);
      note.staveNote.setContext(context).draw();
    });

    beams.forEach((beam, index) => {
      console.log(`Beam ${index + 1}:`);
      const notes = beam.getNotes();
      notes.forEach((note, noteIndex) => {
        console.log(`  Note ${noteIndex + 1}:`, note);
        console.log(`    Keys: ${note.getKeys()}`);
        console.log(`    Duration: ${note.getDuration()}`);
      });
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

    // allNotes.forEach((note) => {
    //   plotMetricsForNote(context, note.staveNote, 10);
    // });

    // plotLegendForNoteWidth(context, barWidth * 2, 150);
  };

  useEffect(() => {
    draw();
  }, []);

  useEffect(() => {
    const handleNote = (noteIndex: number) => {
      setCurrentNoteIndex(noteIndex);
      let note = allNotes[noteIndex];
      let noteElement = document.querySelector(`[data-id="${note.staveNote.getAttribute('id')}"]`);
      if (noteElement) {
        noteElement.remove();
      }

      note.staveNote.setStyle({ fillStyle: 'red', strokeStyle: 'blue' });
      note.staveNote.setContext(context).draw();

      const previousNoteIndex = noteIndex > 0 ? noteIndex - 1 : allNotes.length - 1;
      note = allNotes[previousNoteIndex];
      noteElement = document.querySelector(`[data-id="${note.staveNote.getAttribute('id')}"]`);
      if (noteElement) {
        noteElement.remove();
      }

      note.staveNote.setStyle({ fillStyle: 'black', strokeStyle: 'black' });
      note.staveNote.setContext(context).draw();

      showNoteBar(context, allNotes, noteIndex, 150);
    };

    beatPlayer.on('note', handleNote);

    return () => {
      beatPlayer.off('note', handleNote);
    };
  }, []);

  return <div className="h-full w-full" ref={containerRef} />;
};
