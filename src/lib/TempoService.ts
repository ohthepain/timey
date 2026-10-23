import { WebMidi } from 'webmidi';
import { EventEmitter } from 'events';
import { MidiDevicePreferences, usePreferencesStore } from '~/state/PreferencesStore';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';

// Owns transport state and clock pulses. Capture observes pulses without the
// clock importing the recorder; MIDI and replay use the same transitions.

type TransportState = Readonly<{
  isRunning: boolean;
  isPlaying: boolean;
  isRecording: boolean;
  isReplaying: boolean;
}>;

export class TempoService {
  private static _instance: TempoService | null = null;
  bpm: any;
  eventsEmitter: EventEmitter;
  lastTickTimeMsec: number = 0;
  ppqn: any;
  midiClockPulseInterval: any;
  nextPulseNum: number = 0;
  intervalId: any;

  private transportState: TransportState = Object.freeze({
    isRunning: false,
    isPlaying: false,
    isRecording: false,
    isReplaying: false,
  });

  get isRunning() {
    return this.transportState.isRunning;
  }

  get isPlaying() {
    return this.transportState.isPlaying;
  }

  get isRecording() {
    return this.transportState.isRecording;
  }

  getTransportState = (): TransportState => this.transportState;

  subscribeTransportState = (listener: () => void) => {
    this.eventsEmitter.on('transportChange', listener);
    return () => {
      this.eventsEmitter.off('transportChange', listener);
    };
  };

  private setTransportState(
    mode: 'stopped' | 'playing' | 'recording' | 'running',
    isReplaying = this.transportState.isReplaying
  ) {
    this.transportState = Object.freeze({
      isRunning: mode !== 'stopped',
      isPlaying: mode === 'playing',
      isRecording: mode === 'recording',
      isReplaying,
    });
  }
  isSimulatedTimerForTesting: boolean = false;
  time: number = 0;
  startTimeMsec: number = 0;
  elapsedMsec: number = 0;
  startSpp: number = 0;
  loopSpp: number = 0;
  currentSpp: number = 0;
  fakeMidiClockTimerResolution: number = 4;

  constructor() {
    console.log(`hi from TempoService:ctor`);
    this.eventsEmitter = new EventEmitter();
    this.setPpqn(24);
    this.setTempo(120);
    this.reset();
  }

  stopIntervalTimer() {
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private getTime() {
    if (this.isSimulatedTimerForTesting) {
      return this.time;
    }
    return WebMidi.time;
  }

  prepareIntervalTimer() {
    this.stopIntervalTimer();
    const pps = this.bpm * this.ppqn;
    this.midiClockPulseInterval = (60 * 1000) / pps;

    this.time = 0;
    this.startTimeMsec = this.getTime();
    this.nextPulseNum = 0;
  }

  startSimulatedIntervalTimerForTesting() {
    this.isSimulatedTimerForTesting = true;
    this.time = 0;
    this.startTimeMsec = this.getTime();
    this.elapsedMsec = 0;
    this.startIntervalTimer();
  }

  startIntervalTimer() {
    this.prepareIntervalTimer();
    this.continueIntervalTimer();
  }

  continueIntervalTimer() {
    if (usePersistedStore.getState().midiSlave) {
      return;
    }

    if (!this.isSimulatedTimerForTesting) {
      if (!this.intervalId) {
        this.handleIntervalTimer();
        this.fakeMidiClockTimerResolution = usePreferencesStore.getState().fakeMidiClockTimerResolution || 4;
        this.intervalId = setInterval(
          this.handleIntervalTimer,
          this.midiClockPulseInterval / this.fakeMidiClockTimerResolution
        );
      }
    }
  }

  simulateInterval = (intervalMsec: number) => {
    // Record the timing pulse before any other processing
    this.time += intervalMsec;
    if (this.getTime() !== this.time) {
      throw new Error('TempoService: simulateInterval - time mismatch');
    }
    this.handleIntervalTimer();
  };

  handleIntervalTimer = () => {
    this.time = this.getTime();
    if (this.time > this.startTimeMsec + this.nextPulseNum * this.midiClockPulseInterval) {
      // send fake MIDI clock pulse
      this.sendClock(this.nextPulseNum);
      this.handleMidiClockPulse();
    }
  };

  handleMidiClockPulse = () => {
    this.time = this.getTime();
    this.elapsedMsec = this.time - this.startTimeMsec;
    this.eventsEmitter.emit('midiClockPulse', {
      time: this.elapsedMsec,
      ticks: this.nextPulseNum,
      intervalMsec: this.time - this.lastTickTimeMsec,
    });

    this.lastTickTimeMsec = this.time;

    ++this.nextPulseNum;
  };

  private sendTransportMessage(message: 'sendStart' | 'sendStop' | 'sendContinue') {
    this.eventsEmitter.emit(message === 'sendStop' ? 'stop' : 'start', { time: this.time });
    const preferences = usePreferencesStore.getState().midiDevicePreferences;
    for (const output of WebMidi.outputs) {
      if (preferences.isSyncEnabledForMidiOutputId(output.id)) {
        output[message]();
      }
    }
  }

  sendClock = (timePulses: number) => {
    if (useNavigationStore.getState().isUsingExternalMidiClock) {
      return;
    }

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendClock({ time: timePulses });
      }
    });
  };

  sendSpp = (spp: number) => {
    this.eventsEmitter.emit('SPP', { spp: this.currentSpp });

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendSongPosition(spp);
      }
    });
  };

  sendStateChange = () => {
    this.eventsEmitter.emit('stateChange', {
      isRunning: this.isRunning,
      isPlaying: this.isPlaying,
      isRecording: this.isRecording,
      elapsedMsec: this.getElapsedMsec(),
      elapsed64ths: this.getElapsed64ths(),
      currentSpp: this.currentSpp,
      startSpp: this.startSpp,
      loopSpp: this.loopSpp,
      bpm: this.bpm,
      ppqn: this.ppqn,
    });
    this.eventsEmitter.emit('transportChange');
  };

  setTempo(bpm: any) {
    this.bpm = bpm;
  }

  setPpqn(ppqn: any) {
    this.ppqn = ppqn;
  }

  reset() {
    console.log(`TempoService.reset bpm ${this.bpm}`);
    this.stop();
    this.startTimeMsec = this.time;
    this.lastTickTimeMsec = this.time;
  }

  // TODO: Consider MIDI timecode
  getElapsedMsec(): number {
    const elapsed = this.time - this.startTimeMsec;
    return elapsed;
  }

  // TODO: Consider MIDI timecode
  getElapsed64ths(): number {
    const elapsed64ths = Math.floor(
      ((this.getElapsedMsec() / 60000) * this.bpm * 64) / this.fakeMidiClockTimerResolution
    );
    return elapsed64ths;
  }

  private start() {
    this.time = this.getTime();
    this.startTimeMsec = this.time;
    this.lastTickTimeMsec = this.time;
    this.currentSpp = this.startSpp;
    this.sendSpp(this.currentSpp);
    this.sendStateChange();
    this.sendTransportMessage('sendStart');
    this.sendSpp(this.currentSpp);
    this.prepareIntervalTimer();
    this.continueIntervalTimer();
  }

  play() {
    this.setTransportState('playing');
    this.start();
  }

  record() {
    this.setTransportState('recording');
    this.start();
  }

  continue() {
    this.setTransportState(this.isPlaying ? 'playing' : this.isRecording ? 'recording' : 'running');
    this.sendStateChange();
    this.sendTransportMessage('sendContinue');
    this.continueIntervalTimer();
    this.sendSpp(this.currentSpp);
    this.sendTransportMessage('sendStart');
  }

  stop() {
    this.setTransportState('stopped');
    this.stopIntervalTimer();
    this.currentSpp = this.startSpp;
    this.sendSpp(this.currentSpp);
    this.sendStateChange();
    this.sendTransportMessage('sendStop');
  }

  replay(events: () => void) {
    const previousClockMode = this.isSimulatedTimerForTesting;
    this.stop();
    try {
      this.startSimulatedIntervalTimerForTesting();
      this.setTransportState('recording', true);
      this.start();
      events();
    } finally {
      this.isSimulatedTimerForTesting = previousClockMode;
      this.setTransportState('stopped', false);
      this.stop();
    }
  }

  static getInstance() {
    if (!TempoService._instance) {
      TempoService._instance = new TempoService();
    }
    return TempoService._instance;
  }

  destroy() {
    this.stop();
    this.eventsEmitter.removeAllListeners();
  }

  public static shutdown() {
    if (TempoService._instance) {
      TempoService._instance.destroy();
      TempoService._instance = null;
    }
  }
}
