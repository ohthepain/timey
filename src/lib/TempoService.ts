import { WebMidi } from 'webmidi';
import { EventEmitter } from 'events';
import { MidiDevicePreferences, usePreferencesStore } from '~/state/PreferencesStore';
import { EventRecorderService } from './EventRecorderService';

// TempoService is a singleton that drives the fake MIDI clock and song position pointer
// It can optionally be driven by a MIDI adapter

// TODO: Add a MIDI adapter to the MIDI service that drives tempo service
//  it should use WebMidi.time to set a system midi time value midiTime. This should optionally drive the tempo service
//  (maybe it should also optionally drive the song position pointer)

// Also need MIDI service to subscribe to start and stop events?

export class TempoService {
  private static _instance: TempoService | null = null;
  bpm: any;
  eventsEmitter: EventEmitter;
  lastTickTimeMsec: number = 0;
  ppqn: any;
  midiClockPulseInterval: any;
  nextPulseNum: number = 0;
  intervalId: any;

  isRunning: boolean = false;
  isPlaying: boolean = false;
  isRecording: boolean = false;
  isSimulatedTimerForTesting: boolean = false;
  time: number = 0;
  startTimeMsec: number = 0;
  elapsedMsec: number = 0;
  startSpp: number = 0;
  loopSpp: number = 0;
  currentSpp: number = 0;
  fakeMidiClockTimerResolution: number = 4;

  get eventRecorder(): EventRecorderService {
    return EventRecorderService.getInstance();
  }

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
    if (!this.isSimulatedTimerForTesting) {
      if (!this.intervalId) {
        this.handleIntervalTimer();
        // fakeMidiClockTimerResolution - timer faster than clock pulse to reduce jitter
        this.fakeMidiClockTimerResolution = usePreferencesStore.getState().fakeMidiClockTimerResolution || 4;
        this.intervalId = setInterval(
          this.handleInterval,
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
    this.handleInterval();
  };

  handleIntervalTimer = () => {
    if (this.isSimulatedTimerForTesting) {
      throw new Error('TempoService: handleIntervalTimer - simulated timer but we got a timer pulse');
    }
    this.handleInterval();
  };

  handleInterval = () => {
    this.time = this.getTime();
    this.elapsedMsec = this.time - this.startTimeMsec;

    if (this.time > this.startTimeMsec + this.nextPulseNum * this.midiClockPulseInterval) {
      this.eventRecorder.recordTimingPulse(this.time - this.lastTickTimeMsec);
      this.sendClock(this.nextPulseNum);
      this.eventsEmitter.emit('MIDI Clock Pulse', {
        time: this.elapsedMsec,
        ticks: this.nextPulseNum,
      });

      this.lastTickTimeMsec = this.time;

      ++this.nextPulseNum;
    }
  };

  sendStart = () => {
    console.log(`TempoService.sendStart: ${this.time}`);
    this.eventsEmitter.emit('start', { time: this.time });

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendStart();
      }
    });
  };

  sendStop = () => {
    this.eventsEmitter.emit('stop', { time: this.time });

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendStop();
      }
    });
  };

  sendContinue = () => {
    this.eventsEmitter.emit('start', { time: this.time });

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendContinue();
      }
    });
  };

  // Panic button?
  sendReset = () => {
    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (
        midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id) ||
        midiDevicePreferences.isTrackingEnabledForMidiOutputId(output.id)
      ) {
        output.sendReset();
      }
    });
  };

  sendClock = (timePulses: number) => {
    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      // console.log(`Preferences.getMidiOutputs: ${JSON.stringify(output)}`)
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        // console.log(`TempoService.sendClock: to ${output.name} - ${timePulses} pulses`)
        output.sendClock({ time: timePulses });
      }
    });
  };

  sendSpp = (spp: number) => {
    this.eventsEmitter.emit('SPP', { spp: this.currentSpp });

    const midiDevicePreferences: MidiDevicePreferences = usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      // console.log(`Preferences.getMidiOutputs: ${JSON.stringify(output)}`)
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
    this.isRunning = true;
    this.sendStateChange();
    this.sendStart();
    this.sendSpp(this.currentSpp);
    this.prepareIntervalTimer();
    this.continueIntervalTimer();
  }

  play() {
    this.isPlaying = true;
    this.isRecording = false;
    this.start();
  }

  record() {
    this.isRecording = true;
    this.isPlaying = false;
    this.start();
  }

  continue() {
    this.isRunning = true;
    this.sendStateChange();
    this.sendContinue();
    this.continueIntervalTimer();
    this.sendSpp(this.currentSpp);
    this.sendStart();
  }

  stop() {
    this.isRunning = false;
    this.isPlaying = false;
    this.isRecording = false;
    this.stopIntervalTimer();
    this.currentSpp = this.startSpp;
    this.sendSpp(this.currentSpp);
    this.sendStateChange();
    this.sendStop();
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
