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
  midiInputDevice: Input | null = null;
  midiOutputDevice: Output | undefined = undefined;
  midiInputChannel: any = null;
  midiOutputChannel: any = null;

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

    if (this.midiInputDeviceId && this.midiOutputDeviceId) {
      this.midiOutputDevice = WebMidi.getOutputById(this.midiOutputDeviceId);
      if (!this.midiOutputDevice) {
        throw new Error(`MIDI output device not found: ${this.midiOutputDeviceId}`);
      }
      this.midiOutputChannel = this.midiOutputDevice.channels[this.midiOutputChannelNum];
    }

    if (this.midiInputDeviceId && this.midiInputChannelNum) {
      this.midiInputDevice = WebMidi.getInputById(this.midiInputDeviceId);
      if (!this.midiInputDevice) {
        throw new Error(`MIDI input device not found: ${this.midiInputDeviceId}`);
      }
      this.midiInputChannel = this.midiInputDevice.channels[this.midiInputChannelNum];
    }
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
      this.listenToInput();
    }

    useMidiSettingsStore.subscribe((state) => {
      console.log('MidiSettingsStore state changed:', state);

      if (
        this.midiOutputDeviceId !== state.midiOutputDeviceId ||
        this.midiOutputChannelNum !== state.midiOutputChannelNum
      ) {
        this.midiOutputChannelNum = state.midiOutputChannelNum;
        this.midiOutputDeviceId = state.midiOutputDeviceId;
        const device = WebMidi.getOutputById(this.midiOutputDeviceId);
        if (!device) {
          throw new Error(`MIDI output device not found: ${this.midiOutputDeviceId}`);
        }
        this.midiOutputDevice = device;
        this.midiOutputChannel = device.channels[this.midiOutputChannelNum];
      }

      if (
        this.midiInputDeviceId !== useMidiSettingsStore.getState().midiInputDeviceId ||
        this.midiInputChannelNum !== useMidiSettingsStore.getState().midiInputChannelNum
      ) {
        this.midiInputChannelNum = state.midiInputChannelNum;
        this.midiInputDeviceId = state.midiInputDeviceId;
        console.log(`MIDI Input device changed: ${this.midiInputDeviceId} channelNum: ${this.midiInputChannelNum}`);
        if (!this.midiInputDeviceId) {
          return;
        }

        this.listenToInput();

        this.listenersInitialized = true;
      }
    });
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

  playNote = (
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) => {
    if (!this.midiOutputChannel) {
      throw new Error('MIDI output channel is undefined');
    }

    this.midiOutputChannel.playNote(note, { attack: velocity / 127, duration, time: WebMidi.time + delayMsec });
  };

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

  listenToInput() {
    const midiInputDeviceId = this.midiInputDeviceId;
    const channelNum = this.midiInputChannelNum;
    console.log(`listenToInput ${this.midiInputDeviceId} channelNum: ${this.midiInputChannelNum}`);
    if (!channelNum || !midiInputDeviceId) {
      throw new Error('MIDI Input channel number or device ID is undefined');
    }
    if (!WebMidi.enabled) {
      throw new Error('WebMidi is not enabled');
    }

    this.midiInputDevice = WebMidi.getInputById(midiInputDeviceId);
    if (!this.midiInputDevice) {
      console.warn(`No MIDI input device found: ${midiInputDeviceId}`);
      return;
    }

    if (channelNum) {
      console.log(`listenToInput : channel ${channelNum}`);
      const channel = this.midiInputDevice.channels[channelNum];
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
      this.midiInputDevice.removeListener('noteon');
      this.midiInputDevice.addListener('noteon', (e: NoteMessageEvent) => {
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
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) => {
    midiService.playNote(note, velocity, duration, delayMsec);
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
