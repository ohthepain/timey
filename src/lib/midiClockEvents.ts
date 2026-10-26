export const MIDI_CLOCK_PULSE = 'midiClockPulse' as const;
export const MIDI_CLOCK_LOST = 'midiClockLost' as const;

/** Emitted when an external clock tick should advance transport timing (not the first tick). */
export type MidiClockPulseEvent = {
  now: number;
  bpm: number;
  ppqn: number;
};
