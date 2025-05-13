import { useEffect, useRef } from 'react';
import { Beam, Renderer, Stave, StaveNote, TickContext, Tickable, Barline, RenderContext, drawDot } from 'vexflow';
import { MakeStaveNotesFromBeat, TupletRecord } from '../lib/ParseBeat';
import { beatPlayer } from '~/lib/BeatPlayer';
import { NoteEntry } from '~/lib/ParseBeat';
import { Beat } from '~/types/Beat';
import { useNavigationStore } from '~/state/NavigationStore';
import { BeatNoteFeedback } from '~/lib/PerformanceFeedback';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { BeatNote } from '~/types/BeatNote';

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

const plotMetricsForNote = (
  ctx: RenderContext,
  noteEntry: NoteEntry,
  beat: Beat,
  beatNoteFeedback: BeatNoteFeedback,
  yPos: number
): void => {
  function stroke(x1: number, x2: number, color: string, yy: number = y) {
    ctx.beginPath();
    ctx.setStrokeStyle(color);
    ctx.setFillStyle(color);
    ctx.setLineWidth(3);
    ctx.moveTo(x1 + note.getXShift(), yy);
    ctx.lineTo(x2 + note.getXShift(), yy);
    ctx.stroke();
  }

  const note: Tickable = noteEntry.staveNote;
  const x = note.getAbsoluteX();
  ctx.clearRect(x - 20, yPos - 10, 50, 20);

  let feedback = 'X';
  if (beatNoteFeedback.timingDifferenceMs) {
    feedback = Math.round(beatNoteFeedback.timingDifferenceMs) + '';
  }

  ctx.save();
  ctx.setFont('Arial', 8);
  ctx.setFillStyle('black'); // text color
  ctx.fillText(feedback, x, yPos);

  const y = yPos + 7;
  if (beatNoteFeedback.timingDifferenceMs) {
    const xEnd = x + 20; //(note.getFormatterMetrics().freedom.right || 0);
    stroke(x, xEnd, 'red');
    stroke(x - note.getXShift(), x, '#BBB'); // Shift
    let dotOffset = beatNoteFeedback.timingDifferenceMs / 10;
    if (Math.abs(dotOffset) > 20) {
      dotOffset = dotOffset > 0 ? 20 : -20;
    }
    drawDot(ctx, (x + xEnd) / 2 + dotOffset, y, 'blue');
  }

  // Not sure if this is required
  ctx.restore();
};

const showNoteBar = (ctx: RenderContext, allNotes: NoteEntry[], noteNum: number, y: number): void => {
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

  legend('green', 'Good');
  legend('red', 'Early');
  legend('#999', 'Late');
  legend('#DDD', 'Missed');

  ctx.restore();
};

interface ScoreViewProps {
  beat: Beat;
}

export const ScoreView = ({ beat }: ScoreViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  let context: any;

  const { tuplets, noteEntries } = MakeStaveNotesFromBeat(beat);

  const numBars = Math.max(...noteEntries.map((noteEntry) => noteEntry.barNum)) + 1;

  const width = marginX + barWidth * numBars + marginX;

  useEffect(() => {
    console.log(`ScoreView: beat changed`, beat);
    draw();
  }, [beat]);

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

      const x = getNoteEntryX(noteEntry);
      const note = noteEntry.staveNote;
      const tickContext = new TickContext();
      tickContext.addTickable(note);
      tickContext.preFormat().setX(x);
      note.setTickContext(tickContext);
      note.setStave(stave);
    });

    noteEntries.forEach((note) => {
      note.staveNote.setStave(stave);
      note.staveNote.setContext(context).draw();
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

    plotLegendForNoteWidth(context, barWidth * 2, 150);
  };

  useEffect(() => {
    draw();
  }, []);

  const drawNote = (context: RenderContext, noteIndex: number, fillStyle: string) => {
    let note = noteEntries[noteIndex];
    let noteElement = document.querySelector(`[data-id="${note.staveNote.getAttribute('id')}"]`);
    if (noteElement) {
      noteElement.remove();
    }

    note.staveNote.setStyle({ fillStyle: fillStyle, strokeStyle: 'blue' });
    note.staveNote.setContext(context).draw();

    // const previousNoteIndex = noteIndex > 0 ? noteIndex - 1 : noteEntries.length - 1;
    // note = noteEntries[previousNoteIndex];
    // noteElement = document.querySelector(`[data-id="${note.staveNote.getAttribute('id')}"]`);
    // if (noteElement) {
    //   noteElement.remove();
    // }

    // note.staveNote.setStyle({ fillStyle: 'black', strokeStyle: 'black' });
    // note.staveNote.setContext(context).draw();
  };

  const beatPlayer_note = (noteIndex: number) => {
    if (useNavigationStore.getState().currentBeat !== beat) {
      return;
    }

    drawNote(context, noteIndex, 'green');
    const previousNoteIndex = noteIndex > 0 ? noteIndex - 1 : noteEntries.length - 1;
    drawNote(context, previousNoteIndex, 'black');

    showNoteBar(context, noteEntries, noteIndex, 150);
  };

  const beatRecorder_missedNotes = (beatNoteFeedback: BeatNoteFeedback) => {
    if (useNavigationStore.getState().currentBeat !== beat) {
      return;
    }

    drawNote(context, beatNoteFeedback.index, 'red');
  };

  const beatRecorder_beatNote = (beatNoteFeedback: BeatNoteFeedback | undefined) => {
    // console.log('beatRecorder_beatNote', useNavigationStore.getState().currentBeat);
    if (useNavigationStore.getState().currentBeat !== beat) {
      return;
    }

    if (beatNoteFeedback) {
      drawNote(context, beatNoteFeedback.index, 'green');
      const previousNoteIndex = beatNoteFeedback.index > 0 ? beatNoteFeedback.index - 1 : noteEntries.length - 1;
      drawNote(context, previousNoteIndex, 'black');

      let noteEntry = noteEntries[beatNoteFeedback.index];
      plotMetricsForNote(context, noteEntry, beat, beatNoteFeedback, 10);

      showNoteBar(context, noteEntries, beatNoteFeedback.index, 150);
    }
  };

  useEffect(() => {
    beatPlayer.on('note', beatPlayer_note);
    BeatRecorder.getInstance().on('beatNote', beatRecorder_beatNote);
    BeatRecorder.getInstance().on('missedNotes', beatRecorder_missedNotes);

    return () => {
      beatPlayer.off('note', beatPlayer_note);
      BeatRecorder.getInstance().off('beatNote', beatRecorder_beatNote);
      BeatRecorder.getInstance().off('missedNotes', beatRecorder_missedNotes);
    };
  }, []);

  if (beat.beatNotes.length === 0) {
    return <div>Beat has no notes</div>;
  }

  return <div className="h-full w-full" ref={containerRef} />;
};
