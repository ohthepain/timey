import create from 'zustand';

// Store for synchronization, timing, and song position tracking
// Also adds isPlaying

// TODO: Add MIDI pulses and customizable ppq
// start, stop, continu
// spp (MIDI ticks from start)
// tempo?

// This stuff is a bit too specific to the sequencer, but it's fine for now
// currnetStepNum: the current step number
// pulseNum: the current pulse number
// pulseTime: the current pulse time
// pulseDuration: the duration of the pulse

interface MidiSyncStoreState {
  isPlaying: boolean;
  currentStepNum: number;
  pulseNum: number;
  pulseTime: number;
  pulseDuration: number;
  ppq: number;
  setIsPlaying: (isPlaying: boolean) => void;
  setCurrentStepNum: (stepNum: number) => void;
  setCurrentPulse: (
    stepNum: number,
    pulseNum: number,
    pulseTime: number,
    pulseDuration: number
  ) => void;
  setPPQ: (ppq: number) => void;
}

export const useMidiSyncStore = create<MidiSyncStoreState>((set) => ({
  currentStepNum: 0,
  isPlaying: false,
  pulseNum: 0,
  pulseTime: 0,
  pulseDuration: 0,
  ppq: 24,

  setIsPlaying: (isPlaying: boolean) =>
    set((state: MidiSyncStoreState) => ({ ...state, isPlaying: isPlaying })),
  setCurrentStepNum: (stepNum: number) =>
    set((state: MidiSyncStoreState) => ({ ...state, currentStepNum: stepNum })),
  setCurrentPulse: (
    stepNum: number,
    pulseNum: number,
    pulseTime: number,
    pulseDuration: number
  ) =>
    set((state: MidiSyncStoreState) => ({
      ...state,
      currentStepNum: stepNum,
      pulseNum: pulseNum,
      pulseTime: pulseTime,
      pulseDuration: pulseDuration,
    })),
  setPPQ: (ppq: number) =>
    set((state: MidiSyncStoreState) => ({ ...state, ppq: ppq })),
}));
