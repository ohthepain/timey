import type { RenderContext, Tickable } from 'vexflow';
import type { NoteEntry } from '~/lib/ParseBeat';
import type { BeatNoteFeedback } from '~/lib/PerformanceFeedback';

function clampDotOffset(timingDifferenceMs: number) {
  const dotOffset = timingDifferenceMs / 10;
  if (Math.abs(dotOffset) <= 20) return dotOffset;
  return dotOffset > 0 ? 20 : -20;
}

function strokeSegment(ctx: RenderContext, x1: number, x2: number, y: number, color: string, xShift = 0) {
  ctx.beginPath();
  ctx.setStrokeStyle(color);
  ctx.setFillStyle(color);
  ctx.setLineWidth(3);
  ctx.moveTo(x1 + xShift, y);
  ctx.lineTo(x2 + xShift, y);
  ctx.stroke();
}

export function plotMetricsForNote(
  ctx: RenderContext,
  noteEntry: NoteEntry,
  beatNoteFeedback: BeatNoteFeedback,
  yPos: number,
  drawDot: (ctx: RenderContext, x: number, y: number, color: string) => void
) {
  const note: Tickable = noteEntry.staveNote;
  const x = note.getAbsoluteX();
  ctx.clearRect(x - 20, yPos - 10, 50, 20);

  const label = beatNoteFeedback.timingDifferenceMs ? `${Math.round(beatNoteFeedback.timingDifferenceMs)}` : 'X';
  ctx.save();
  ctx.setFont('Arial', 8);
  ctx.setFillStyle('black');
  ctx.fillText(label, x, yPos);

  const timingY = yPos + 7;
  if (beatNoteFeedback.timingDifferenceMs) {
    const xEnd = x + 20;
    strokeSegment(ctx, x, xEnd, timingY, 'red');
    strokeSegment(ctx, x - note.getXShift(), x, timingY, '#BBB');
    drawDot(ctx, (x + xEnd) / 2 + clampDotOffset(beatNoteFeedback.timingDifferenceMs), timingY, 'blue');
  }
  ctx.restore();
}
