type NoteWriteContext = {
  barNum: number;
  beatNumber: number;
  divisionNumber: number;
  noteIndex: number;
  notesThisQuarterNote: number;
};

function voiceKeysFromChars(beats: string[], charIndex: number): string[] {
  const keys: string[] = [];
  for (const beat of beats) {
    const ch = beat[charIndex];
    if (ch === 'h') keys.push('hihat');
    if (ch === 'k') keys.push('kick');
    if (ch === 's') keys.push('snare');
  }
  return keys.length ? keys : ['rest'];
}

function voiceKeysFromEighth(beats: string[]): string[] {
  const keys: string[] = [];
  for (const beat of beats) {
    if (beat.includes('h')) keys.push('hihat');
    if (beat.includes('k')) keys.push('kick');
    if (beat.includes('s')) keys.push('snare');
  }
  return keys.length ? keys : ['rest'];
}

function appendNoteLine(
  result: string[],
  ctx: NoteWriteContext,
  duration: number,
  keys: string[],
  subdivisions: number,
  subIndex: number
) {
  result.push(
    `note,${ctx.noteIndex++},${duration},[${keys.join(', ')}],${ctx.barNum},${ctx.beatNumber},${ctx.divisionNumber},${subIndex},${subdivisions}`
  );
  ctx.notesThisQuarterNote += 1;
}

function writeTripletNotes(result: string[], tuples: string[], ctx: NoteWriteContext, beats: string[]) {
  tuples.push(`tuple,${ctx.barNum},${Math.floor(ctx.beatNumber)},${ctx.notesThisQuarterNote},3`);
  for (let j = 0; j < 3; j++) {
    appendNoteLine(result, ctx, 16, voiceKeysFromChars(beats, j), 3, j);
  }
}

function writeSixteenthPair(result: string[], ctx: NoteWriteContext, beats: string[]) {
  for (let j = 0; j < 2; j++) {
    appendNoteLine(result, ctx, 16, voiceKeysFromChars(beats, j), 2, j);
  }
}

function writeEighthNote(result: string[], ctx: NoteWriteContext, beats: string[]) {
  appendNoteLine(result, ctx, 8, voiceKeysFromEighth(beats), 1, 0);
}

function subdivisionKind(beats: string[]) {
  if (beats.some((beat) => beat.length === 3)) return 'triplet';
  if (beats.some((beat) => beat.length === 2)) return 'sixteenth-pair';
  return 'eighth';
}

export function parseBarSource(barNum: number, beatStrings: string[]): string {
  const beatArrays = beatStrings.map((beatStr) => beatStr.split(','));
  const result: string[] = ['// note,index,duration,keys,barNum,beatNum,divisionNum,subDivisionNum,numSubDivisions'];
  const tuples: string[] = ['// tuple,barNum,beatNum,startIndex,numNotes'];
  const ctx: NoteWriteContext = {
    barNum,
    beatNumber: -1,
    divisionNumber: -1,
    noteIndex: 0,
    notesThisQuarterNote: 0,
  };

  result.push(`bar,${barNum}`);
  const maxBeats = Math.max(...beatArrays.map((arr) => arr.length));

  for (let i = 0; i < maxBeats; i++) {
    const currentBeats = beatArrays.map((arr) => arr[i] || '');
    const quarterNoteIndex = Math.floor(i / 2);
    if (i % 2 === 0) {
      ctx.beatNumber += 1;
      ctx.divisionNumber = -1;
      ctx.notesThisQuarterNote = 0;
      result.push(`beat,${quarterNoteIndex}`);
    }
    ctx.divisionNumber += 1;

    const kind = subdivisionKind(currentBeats);
    if (kind === 'triplet') writeTripletNotes(result, tuples, ctx, currentBeats);
    else if (kind === 'sixteenth-pair') writeSixteenthPair(result, ctx, currentBeats);
    else writeEighthNote(result, ctx, currentBeats);
  }

  return [...result, ...tuples].join('\n');
}
