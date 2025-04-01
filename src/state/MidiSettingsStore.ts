import { create } from 'zustand';

interface MidiSettingsState {
  midiInputDeviceId: string;
  midiInputDeviceName: string;
  midiInputChannelNum: number;
  midiOutputDeviceId: string;
  midiOutputDeviceName: string;
  midiOutputChannelNum: number;

  // Actions
  setMidiInputDevice: (id: string, name: string, channelNum: number) => void;
  setMidiOutputDevice: (id: string, name: string, channelNum: number) => void;

  resetSettings: () => void;
}

export const useMidiSettingsStore = create<MidiSettingsState>((set) => ({
  // Initial state
  midiInputDeviceId: '',
  midiInputDeviceName: '',
  midiInputChannelNum: -1,
  midiOutputDeviceId: '',
  midiOutputDeviceName: '',
  midiOutputChannelNum: 0,

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

  resetSettings: () =>
    set(() => ({
      midiInputDeviceId: '',
      midiInputDeviceName: '',
      midiInputChannelNum: -1,
      midiOutputDeviceId: '',
      midiOutputDeviceName: '',
      midiOutputChannelNum: 0,
    })),
}));
