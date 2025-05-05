import { WebMidi } from 'webmidi';
import { EventEmitter } from 'events';
import { MidiDevicePreferences, usePreferencesStore } from '~/state/PreferencesStore';

// TempoService is a singleton that drives the MIDI clock and song position pointer
// It can optionally be driven by a MIDI adapter

// TODO: Add a MIDI adapter to the MIDI service that drives tempo service
//  it should use WebMidi.time to set a system midi time value midiTime. This should optionally drive the tempo service
//  (maybe it should also optionally drive the song position pointer)

// Also need MIDI service to subscribe to start and stop events?

class TempoService {
  bpm: any;
  eventsEmitter: EventEmitter;
  lastTickTime: any;
  ppqn: any;
  pulseIntervalMsec: any;
  nextPulseNum: number = 0;
  intervalId: any;

  isRunning: boolean = false;
  isPlaying: boolean = false;
  isRecording: boolean = false;
  time: number = 0;
  startTime: number = 0;
  elapsedMsec: number = 0;
  startSpp: number = 0;
  loopSpp: number = 0;
  currentSpp: number = 0;

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

  startIntervalTimer() {
    this.stopIntervalTimer();
    const pps = this.bpm * this.ppqn;
    this.pulseIntervalMsec = (60 * 1000) / pps;

    this.time = WebMidi.time;
    this.startTime = this.time;
    this.nextPulseNum = 0;

    this.handleInterval();
    this.intervalId = setInterval(this.handleInterval, this.pulseIntervalMsec);
  }

  continueIntervalTimer() {
    if (!this.intervalId) {
      this.startIntervalTimer();
    }
  }

  handleInterval = () => {
    this.time = WebMidi.time;
    this.elapsedMsec = this.time - this.startTime;
    // const pulseCount = elapsedMsec / this.pulseIntervalMsec;

    this.currentSpp = Math.floor(((this.getElapsedMsec() / this.pulseIntervalMsec) * 16) / this.ppqn);
    if (this.loopSpp !== 0 && this.currentSpp > this.loopSpp) {
      this.currentSpp = this.loopSpp;
      this.sendSpp(this.currentSpp);
    }

    if (this.time > this.startTime + this.nextPulseNum * this.pulseIntervalMsec) {
      this.sendClock(this.nextPulseNum);
      this.eventsEmitter.emit('MIDI Clock Pulse', {
        time: this.elapsedMsec,
        ticks: this.nextPulseNum,
      });

      this.lastTickTime = this.time;

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
    this.startTime = this.time;
    this.lastTickTime = this.time;
  }

  // TODO: Consider MIDI timecode
  getElapsedMsec(): number {
    const elapsed = this.time - this.startTime;
    // console.log(`getElapsedMsec: WebMidi.time ${WebMidi.time} this.startTime ${this.startTime} = elapsed ${elapsed} ==> ${Math.floor(elapsed/1000)} seconds}`)
    return elapsed;
  }

  // TODO: Consider MIDI timecode
  getElapsed64ths(): number {
    const elapsed64ths = Math.floor(((this.getElapsedMsec() / 60000) * this.bpm * 64) / 4);
    // const elapsed64ths = this.getElapsedMsec() / this.pulseIntervalMsec / this.ppqn * 16
    // console.log(`getElapsed64ths: msec ${Math.floor(this.getElapsedMsec())} -> getElapsed64ths ${elapsed64ths} at bpm ${this.bpm}`)
    return elapsed64ths;
  }

  private start() {
    this.time = WebMidi.time;
    this.startTime = this.time;
    this.currentSpp = this.startSpp;
    this.sendSpp(this.currentSpp);
    this.isRunning = true;
    this.sendStateChange();
    this.sendStart();
    this.sendSpp(this.currentSpp);
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
    this.startIntervalTimer();
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
}

export const tempoService = new TempoService();
