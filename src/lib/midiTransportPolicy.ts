import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';

export type MidiTransportPolicy = {
  followSlaveTransportCommands: () => boolean;
  setExternalMidiClock: (active: boolean, bpm?: number, ppqn?: number) => void;
};

let policy: MidiTransportPolicy = {
  followSlaveTransportCommands: () => usePersistedStore.getState().midiSlave,
  setExternalMidiClock: (active, bpm, ppqn) =>
    useNavigationStore.getState().setExternalMidiClockState(active, bpm, ppqn),
};

export function configureMidiTransportPolicy(next: Partial<MidiTransportPolicy>) {
  policy = { ...policy, ...next };
}

export function midiTransportPolicy(): MidiTransportPolicy {
  return policy;
}
