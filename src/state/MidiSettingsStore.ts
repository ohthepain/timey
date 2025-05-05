import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MidiSettingsState {
  midiInputDeviceId: string;
  midiInputDeviceName: string;
  midiInputChannelNum: number;
  midiOutputDeviceId: string;
  midiOutputDeviceName: string;
  midiOutputChannelNum: number;
  metronomeNoteNumber: number;
  metronomeVelocity: number;
  metronomeDownbeatNoteNumber: number;
  isDownbeatLocked: boolean;
  metronomeUpbeatNoteNumber: number;
  isUpbeatLocked: boolean;

  // Actions
  setMidiInputDevice: (id: string, name: string, channelNum: number) => void;
  setMidiOutputDevice: (id: string, name: string, channelNum: number) => void;

  setMetronomeNoteNumber: (noteNumber: number) => void;
  setMetronomeVelocity: (velocity: number) => void;
  setMetronomeDownbeatNoteNumber: (noteNumber: number) => void;
  setIsDownbeatLocked: (locked: boolean) => void;
  setMetronomeUpbeatNoteNumber: (noteNumber: number) => void;
  setIsUpbeatLocked: (locked: boolean) => void;

  resetSettings: () => void;
}

export const useMidiSettingsStore = create(
  persist<MidiSettingsState>(
    (set) => ({
      // Initial state
      midiInputDeviceId: '',
      midiInputDeviceName: '',
      midiInputChannelNum: 10,
      midiOutputDeviceId: '',
      midiOutputDeviceName: '',
      midiOutputChannelNum: 10,
      metronomeNoteNumber: 75,
      metronomeVelocity: 100,
      metronomeDownbeatNoteNumber: 76,
      isDownbeatLocked: false,
      metronomeUpbeatNoteNumber: 75,
      isUpbeatLocked: false,

      // Actions
      setMidiInputDevice: (id, name, channelNum) =>
        set(() => ({
          midiInputDeviceId: id,
          midiInputDeviceName: name,
          midiInputChannelNum: channelNum,
        })),

      setMidiOutputDevice: (id, name, channelNum) =>
        set(() => ({
          midiOutputDeviceId: id,
          midiOutputDeviceName: name,
          midiOutputChannelNum: channelNum,
        })),

      setMetronomeNoteNumber: (noteNumber: number) =>
        set(() => ({
          metronomeNoteNumber: noteNumber,
        })),
      setMetronomeVelocity: (velocity: number) =>
        set(() => ({
          metronomeVelocity: velocity,
        })),
      setMetronomeDownbeatNoteNumber: (noteNumber: number) =>
        set(() => ({
          metronomeDownbeatNoteNumber: noteNumber,
        })),
      setIsDownbeatLocked: (locked: boolean) =>
        set(() => ({
          isDownbeatLocked: locked,
        })),
      setMetronomeUpbeatNoteNumber: (noteNumber: number) =>
        set(() => ({
          metronomeUpbeatNoteNumber: noteNumber,
        })),
      setIsUpbeatLocked: (locked: boolean) =>
        set(() => ({
          isUpbeatLocked: locked,
        })),

      resetSettings: () =>
        set(() => ({
          midiInputDeviceId: '',
          midiInputDeviceName: '',
          midiInputChannelNum: -1,
          midiOutputDeviceId: '',
          midiOutputDeviceName: '',
          midiOutputChannelNum: 0,
        })),
    }),
    {
      name: 'midi-settings', // Key for local storage
    }
  )
);
