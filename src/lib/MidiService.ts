import { useEffect } from 'react';
import { Input, NoteMessageEvent, Output, WebMidi } from 'webmidi';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { EventEmitter } from 'events';
import { TempoService } from '~/lib/TempoService';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';

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
  private lastClockTime: number = 0;
  private clockCount: number = 0;
  private clockTimeout: any = null;

  constructor() {
    super();
    this.enable();
  }

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  async enable() {
    if (this.tempoService.isSimulatedTimerForTesting) {
      return;
    }
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

  emitMidiNote(note: number, velocity: number) {
    this.emit('midiNote', { note: note, velocity: velocity || 100 });
  }

  listenToInput() {
    const midiInputDeviceId = this.midiInputDeviceId;
    const channelNum = this.midiInputChannelNum;
    console.log(`listenToInput ${this.midiInputDeviceId} channelNum: ${this.midiInputChannelNum}`);
    if (!channelNum || !midiInputDeviceId) {
      console.warn('MIDI Input channel number or device ID is undefined');
      return;
    }
    if (!WebMidi.enabled) {
      throw new Error('WebMidi is not enabled');
    }

    this.midiInputDevice = WebMidi.getInputById(midiInputDeviceId);
    if (!this.midiInputDevice) {
      console.warn(`No MIDI input device found: ${midiInputDeviceId}`);
      return;
    }

    // Remove existing listeners
    this.midiInputDevice.removeListener('clock');
    this.midiInputDevice.removeListener('start');
    this.midiInputDevice.removeListener('stop');
    this.midiInputDevice.removeListener('continue');

    // Add MIDI clock listeners
    this.midiInputDevice.addListener('clock', this.handleMidiClock);
    this.midiInputDevice.addListener('start', this.handleMidiStart);
    this.midiInputDevice.addListener('stop', this.handleMidiStop);
    this.midiInputDevice.addListener('continue', this.handleMidiContinue);

    if (channelNum) {
      console.log(`listenToInput : channel ${channelNum}`);
      const channel = this.midiInputDevice.channels[channelNum];
      if (!channel) {
        console.warn(`MIDI Input channel not found: ${channelNum}`);
        return;
      }

      channel.removeListener('noteon');
      channel.addListener('noteon', (e) => {
        if (e.message.type === 'noteon') {
          const note = e.message.dataBytes[0];
          const velocity = e.message.dataBytes[1];
          this.emitMidiNote(note, velocity);
        }
      });
    } else {
      console.log(`listenToInput : all channels`);
      this.midiInputDevice.addListener('noteon', (e: NoteMessageEvent) => {
        if (e.message.type === 'noteon') {
          const note = e.message.dataBytes[0];
          const velocity = e.message.dataBytes[1];
          this.emitMidiNote(note, velocity);
        }
      });
    }
  }

  private handleMidiClock = () => {
    const now = WebMidi.time;

    // Clear any existing timeout
    if (this.clockTimeout) {
      clearTimeout(this.clockTimeout);
    }

    // Set a timeout to detect when clock stops
    this.clockTimeout = setTimeout(() => {
      useNavigationStore.getState().setExternalMidiClockState(false);
      // Only restart internal clock if we're in an active state
      if (this.tempoService.isPlaying || this.tempoService.isRecording) {
        this.tempoService.startIntervalTimer();
      }
    }, 1000); // If no clock for 1 second, assume it stopped

    // Calculate BPM based on clock timing
    if (this.lastClockTime > 0) {
      const interval = now - this.lastClockTime;
      const bpm = 60000 / (interval * 24); // 24 PPQN is standard

      // Update state with external clock info
      useNavigationStore.getState().setExternalMidiClockState(true, bpm, 24);

      // Stop internal clock if it's running
      this.tempoService.stopIntervalTimer();

      // Forward the clock pulse to TempoService
      this.tempoService.handleMidiClockPulse();
    }

    this.lastClockTime = now;
    this.clockCount++;
  };

  private handleMidiStart = () => {
    if (usePersistedStore.getState().midiSlave) {
      this.tempoService.record();
    }
  };

  private handleMidiStop = () => {
    this.tempoService.stop();
  };

  private handleMidiContinue = () => {
    this.tempoService.continue();
  };
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
