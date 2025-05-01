import { useEffect } from 'react';
import { Input, NoteMessageEvent, Output, WebMidi } from 'webmidi';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { EventEmitter } from 'events';

class MidiService extends EventEmitter {
  receivedResponse: boolean = false;
  midiInputs: Array<{ id: string; label: string }> = [];
  midiOutputs: Array<{ id: string; label: string }> = [];
  listenersInitialized: boolean = false;
  midiOutputChannelNum: number = useMidiSettingsStore.getState().midiOutputChannelNum;
  midiOutputDeviceId: string | null = useMidiSettingsStore.getState().midiOutputDeviceId;
  midiInputChannelNum: number = useMidiSettingsStore.getState().midiInputChannelNum;
  midiInputDeviceId: string | null = useMidiSettingsStore.getState().midiInputDeviceId;

  constructor() {
    super();
    this.enable();
  }

  async enable() {
    if (!WebMidi.enabled) {
      console.log('WebMidi not enabled, enabling...');
      try {
        await WebMidi.enable({ sysex: true });
      } catch (error) {
        console.error('Error enabling WebMidi:', error);
        return;
      }
    }
    console.log('WebMidi enabled (MidiService)');
    this.refreshDevices();
    this.initListeners();
  }

  isEnabled() {
    return WebMidi.enabled;
  }

  refreshDevices() {
    console.log('refreshDevices');
    this.midiInputs = WebMidi.inputs.map((input: Input) => ({ id: input.id, label: input.name }));
    this.midiOutputs = WebMidi.outputs.map((output: Output) => ({ id: output.id, label: output.name }));
    console.log('refreshDevices: ', this.midiInputs, this.midiOutputs);
  }

  initListeners() {
    console.log(`initListeners ${this.midiInputDeviceId} ${this.midiInputChannelNum}`);
    if (this.listenersInitialized) {
      return;
    }
    console.log('initListeners 2');
    WebMidi.addListener('connected', () => {
      this.refreshDevices();
    });
    WebMidi.addListener('disconnected', () => {
      this.refreshDevices();
    });

    this.refreshDevices();
    if (this.midiInputDeviceId) {
      this.listenToInput(this.midiInputDeviceId, this.midiInputChannelNum);
    }

    useMidiSettingsStore.subscribe((state) => {
      console.log('MidiSettingsStore state changed:', state);
      if (
        this.midiInputDeviceId === useMidiSettingsStore.getState().midiInputDeviceId &&
        this.midiInputChannelNum === useMidiSettingsStore.getState().midiInputChannelNum
      ) {
        return;
      }

      // this.midiInputDeviceId = useMidiSettingsStore.getState().midiInputDeviceId;
      // this.midiInputChannelNum = useMidiSettingsStore.getState().midiInputChannelNum;
      this.midiInputChannelNum = state.midiInputChannelNum;
      this.midiInputDeviceId = state.midiInputDeviceId;
      console.log(`MIDI Input device changed: ${this.midiInputDeviceId} channelNum: ${this.midiInputChannelNum}`);
      if (!this.midiInputDeviceId) {
        return;
      }

      this.listenToInput(this.midiInputDeviceId, this.midiInputChannelNum);
    });

    this.listenersInitialized = true;
  }

  getMidiInputs(): Array<{ id: string; label: string }> {
    return this.midiInputs;
  }

  getMidiOutputs(): Array<{ id: string; label: string }> {
    return this.midiOutputs;
  }

  getDeviceNameById(deviceId: string, isInput: boolean): string | null {
    const devices = isInput ? WebMidi.inputs : WebMidi.outputs;
    const device = devices.find((d) => d.id === deviceId);
    return device ? device.name : null;
  }

  playNote(
    midiOutputDeviceId: string,
    channelNum: number,
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) {
    let midiOutputDevice = WebMidi.getOutputById(midiOutputDeviceId);
    if (!midiOutputDevice) {
      const midiOutputDeviceName = this.getDeviceNameById(midiOutputDeviceId, false);
      console.warn(`No MIDI output device found: ${midiOutputDeviceName}/${midiOutputDeviceId}`);
      return;
    }

    const outputChannel = midiOutputDevice.channels[channelNum];
    if (!outputChannel) {
      throw new Error('MIDI output channel is undefined');
    }

    const attack = velocity / 127;

    outputChannel.playNote(note, { attack: attack, duration, time: WebMidi.time + delayMsec });
  }

  sendControlChange(midiSettings: any, ccNumber: number, value: number) {
    if (!midiSettings.midiOutputDeviceId) {
      console.warn('MidiService.sendControlChange: Please select output device');
      return;
    }
    if (midiSettings.midiOutputChannelNum == null) {
      console.warn('MidiService.sendControlChange: Please select output channel');
      return;
    }

    const midiOutputDevice = WebMidi.getOutputById(midiSettings.midiOutputDeviceId);
    if (!midiOutputDevice) {
      console.warn(`Output device ${midiSettings.midiOutputDeviceId} not found`);
      return;
    }

    const outputChannel = midiOutputDevice.channels[midiSettings.midiOutputChannelNum];
    outputChannel.sendControlChange(ccNumber, value);
  }

  listenToInput(midiInputDeviceId: string, channelNum?: number) {
    console.log(`listenToInput ${midiInputDeviceId} channelNum: ${channelNum}`);
    const input = WebMidi.getInputById(midiInputDeviceId);
    if (!input) {
      console.warn(`No MIDI input device found: ${midiInputDeviceId}`);
      return;
    }

    if (channelNum) {
      console.log(`listenToInput : channel ${channelNum}`);
      const channel = input.channels[channelNum];
      if (!channel) {
        console.warn(`MIDI Input channel not found: ${channelNum}`);
        return;
      }

      channel.removeListener('noteon');
      channel.addListener('noteon', (e) => {
        this.emit('midiNote', e);
      });
    } else {
      console.log(`listenToInput : all channels`);
      input.removeListener('noteon');
      input.addListener('noteon', (e: NoteMessageEvent) => {
        this.emit('midiNote', e);
      });
    }
  }
}

export const midiService = new MidiService();

export function useMidiService() {
  const getDeviceNameById = (deviceId: string, isInput: boolean): string | null => {
    return midiService.getDeviceNameById(deviceId, isInput);
  };

  const playNote = (
    midiOutputDeviceId: string,
    channelNum: number,
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) => {
    midiService.playNote(midiOutputDeviceId, channelNum, note, velocity, duration, delayMsec);
  };

  useEffect(() => {
    if (!WebMidi.enabled) {
      midiService.enable().then(() => {
        console.log('WebMidi enabled from useMidiService');
      });
    }
  }, []);

  const isEnabled = () => {
    return midiService.isEnabled();
  };

  return {
    isEnabled,
    getDeviceNameById,
    playNote,
    get midiInputs() {
      return midiService.getMidiInputs();
    },
    get midiOutputs() {
      return midiService.getMidiOutputs();
    },
  };
}
