import { BarSource, BeatSource } from '~/types/BarSource';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';

const BAR_VOICE_KEYS = ['kick', 'hihat', 'snare', 'accent'] as const;

function emptyBar(): BarSource {
  return { kick: '', hihat: '', snare: '', accent: '' };
}

function trimBarVoiceSuffixes(bar: BarSource, pattern: RegExp) {
  for (const key of BAR_VOICE_KEYS) {
    bar[key] = bar[key].replace(pattern, '');
  }
}

function appendVoiceGlyphs(bar: BarSource, voices: string[]) {
  bar.kick += voices.includes('kick') ? 'k' : 'x';
  bar.hihat += voices.includes('hihat') ? 'h' : 'x';
  bar.snare += voices.includes('snare') ? 's' : 'x';
  bar.accent += voices.includes('accent') ? 'a' : 'x';
}

function appendBarCommas(bar: BarSource) {
  bar.kick += ',';
  bar.hihat += ',';
  bar.snare += ',';
  bar.accent += ',';
}

function applyNoteToBar(bar: BarSource, note: BeatNote, isLastNote: boolean, subdivisionDone: boolean) {
  const voices = note.noteString.split(',').map((s) => s.trim());
  appendVoiceGlyphs(bar, voices);
  if (!subdivisionDone) return;
  trimBarVoiceSuffixes(bar, /x+$/);
  if (!isLastNote) appendBarCommas(bar);
}

export function createBeatSourceFromBeat(beat: Beat): BeatSource {
  const barsMap = new Map<number, BarSource>();
  let subdivisionNum = 0;

  for (let i = 0; i < beat.beatNotes.length; i++) {
    const note = beat.beatNotes[i];
    if (subdivisionNum === 0) subdivisionNum = note.numSubDivisions;
    subdivisionNum -= 1;

    const bar = barsMap.get(note.barNum) ?? emptyBar();
    applyNoteToBar(bar, note, i >= beat.beatNotes.length - 1, subdivisionNum === 0);
    barsMap.set(note.barNum, bar);
  }

  for (const bar of barsMap.values()) trimBarVoiceSuffixes(bar, /,$/);

  const bars = Array.from(barsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, bar]) => bar);
  return new BeatSource(bars);
}
