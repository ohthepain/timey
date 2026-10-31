import { GeneralMidiService } from '~/lib/GeneralMidiService';

const ALIAS_GROUPS: Array<{ voice: string; notes: number[] }> = [
  { voice: 'hihat', notes: [42, 46, 51, 53, 59] },
  { voice: 'kick', notes: [36, 35] },
  { voice: 'snare', notes: [37, 38, 39, 40] },
];

export function matchBeatNoteMidi(noteString: string, midiNote: number): string | null {
  const drumName = GeneralMidiService.getDrumName(midiNote);
  if (!drumName) throw new Error(`Unknown MIDI note: ${midiNote}`);

  const notes = noteString.split(', ');
  if (notes.includes(drumName)) return drumName;

  for (const { voice, notes: aliases } of ALIAS_GROUPS) {
    if (!notes.includes(voice) || !aliases.includes(midiNote)) continue;
    return voice;
  }
  return null;
}
