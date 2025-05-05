import { create } from 'zustand';
import { produce } from 'immer';

export class MidiDeviceSettings {
  deviceId: string = '';
  deviceName: string = '';
  track: boolean = true;
  sync: boolean = false;
  remote: boolean = false;
}

export class MidiDevicePreferences {
  inputs: Array<MidiDeviceSettings> = [];
  outputs: Array<MidiDeviceSettings> = [];

  constructor(data: any) {
    if (data.inputs) {
      this.inputs = [...data.inputs];
    }
    if (data.outputs) {
      this.outputs = [...data.outputs];
    }
  }

  getMidiInputDevicePreferences(
    deviceId: string,
    deviceName: string | undefined = undefined
  ): MidiDeviceSettings | undefined {
    let settings: MidiDeviceSettings | undefined = this.inputs.find((candidate) => candidate.deviceId === deviceId);
    if (settings === undefined && deviceName !== undefined) {
      settings = this.inputs.find((candidate) => candidate.deviceName === deviceName);
    }

    return settings;
  }

  getMidiOutputDevicePreferences(deviceId: string, deviceName?: string): MidiDeviceSettings | undefined {
    let settings: MidiDeviceSettings | undefined = this.outputs.find((candidate) => candidate.deviceId === deviceId);
    if (settings === undefined && deviceName !== undefined) {
      settings = this.outputs.find((candidate) => candidate.deviceName === deviceName);
    }

    return settings;
  }

  isTrackingEnabledForMidiInputId(deviceId: string): boolean {
    const deviceSettings: MidiDeviceSettings | undefined = this.getMidiInputDevicePreferences(deviceId);
    const enabled = deviceSettings !== undefined ? deviceSettings.track : true;
    return enabled;
  }

  isRemoteEnabledForMidiInputId(deviceId: string): boolean {
    const deviceSettings: MidiDeviceSettings | undefined = this.getMidiInputDevicePreferences(deviceId);
    const enabled = deviceSettings !== undefined ? deviceSettings.remote : true;
    return enabled;
  }

  isTrackingEnabledForMidiOutputId(deviceId: string): boolean {
    const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId);
    const enabled = deviceSettings !== undefined ? deviceSettings.track : true;
    return enabled;
  }

  isSyncEnabledForMidiOutputId(deviceId: string): boolean {
    const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId);
    const enabled = deviceSettings !== undefined ? deviceSettings.sync : false;
    return enabled;
  }

  isRemoteEnabledForMidiOutputId(deviceId: string): boolean {
    const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId);
    const enabled = deviceSettings !== undefined ? deviceSettings.remote : true;
    return enabled;
  }
}

export type PreferencesState = {
  midiDevicePreferences: MidiDevicePreferences;
  numCountInBars: number;
  useFakeMidiClock: boolean;
  fakeMidiClockTimerResolution: number;
  loadMidiDevicePreferences: (midiDeviceSettings: MidiDevicePreferences) => void;
  setMidiInputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => void;
  setMidiOutputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => void;
  setNumCountInBars: (numCountInBars: number) => void;
  setUseFakeMidiClock: (useFakeMidiClock: boolean) => void;
  setFakeMidiClockTimerResolution: (fakeMidiClockTimerResolution: number) => void;
};

const loadMidiDevicePreferences = (draft: PreferencesState, midiDevicePreferences: MidiDevicePreferences) => {
  draft.midiDevicePreferences = midiDevicePreferences;
};

const setMidiInputDeviceSettings = (draft: PreferencesState, midiDeviceSettings: MidiDeviceSettings) => {
  let index: number = draft.midiDevicePreferences.inputs.findIndex(
    (candidate) => candidate.deviceId === midiDeviceSettings.deviceId
  );
  if (index === -1) {
    index = draft.midiDevicePreferences.inputs.findIndex(
      (candidate) => candidate.deviceName === midiDeviceSettings.deviceName
    );
  }

  if (index !== -1) {
    draft.midiDevicePreferences.inputs[index] = { ...midiDeviceSettings };
  } else {
    draft.midiDevicePreferences.inputs.push({ ...midiDeviceSettings });
  }
};

const setMidiOutputDeviceSettings = (draft: PreferencesState, midiDeviceSettings: MidiDeviceSettings) => {
  //console.log(`setMidiInputDeviceSettings.setMidiOutputDeviceSettings(${JSON.stringify(midiDeviceSettings)})`)
  let index: number = draft.midiDevicePreferences.outputs.findIndex(
    (candidate) => candidate.deviceId === midiDeviceSettings.deviceId
  );
  if (index === -1) {
    index = draft.midiDevicePreferences.outputs.findIndex(
      (candidate) => candidate.deviceName === midiDeviceSettings.deviceName
    );
  }

  if (index !== -1) {
    draft.midiDevicePreferences.outputs[index] = { ...midiDeviceSettings };
  } else {
    draft.midiDevicePreferences.outputs.push({ ...midiDeviceSettings });
  }
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  midiDevicePreferences: new MidiDevicePreferences({}),
  numCountInBars: 1,
  useFakeMidiClock: true,
  fakeMidiClockTimerResolution: 4,
  loadMidiDevicePreferences: (midiDevicePreferences: MidiDevicePreferences) =>
    set(produce((state) => loadMidiDevicePreferences(state, midiDevicePreferences))),
  setMidiInputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) =>
    set(produce((state) => setMidiInputDeviceSettings(state, midiDeviceSettings))),
  setMidiOutputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) =>
    set(produce((state) => setMidiOutputDeviceSettings(state, midiDeviceSettings))),
  setNumCountInBars: (numCountInBars: number) =>
    set(
      produce((state) => {
        state.numCountInBars = numCountInBars;
      })
    ),
  setUseFakeMidiClock: (useFakeMidiClock: boolean) =>
    set(
      produce((state) => {
        state.useFakeMidiClock = useFakeMidiClock;
      })
    ),
  setFakeMidiClockTimerResolution: (fakeMidiClockTimerResolution: number) =>
    set(
      produce((state) => {
        state.fakeMidiClockTimerResolution = fakeMidiClockTimerResolution;
      })
    ),
}));
