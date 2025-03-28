import { WebMidi } from 'webmidi';
import { EventEmitter } from 'events';
import {
  MidiDevicePreferences,
  MidiDeviceSettings,
  usePreferencesStore,
} from '~/state/PreferencesStore';

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
  startTime: any;
  nextPulseNum: number = 0;
  intervalId: any;

  isRunning: boolean = false;
  time: number = 0;
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
    console.log(`TempoService.stopIntervalTimer`);
    clearInterval(this.intervalId);
    this.eventsEmitter.emit('SPP', { spp: 0 });
    this.eventsEmitter.emit('');
  }

  startIntervalTimer() {
    this.stopIntervalTimer();
    console.log(`TempoService.startIntervalTimer`);
    const pps = this.bpm * this.ppqn;
    this.pulseIntervalMsec = (60 * 1000) / pps;
    console.log(
      `TempoService.startIntervalTimer bpm ${this.bpm} interval ${this.pulseIntervalMsec} msec @ ${this.ppqn} = ${this.pulseIntervalMsec * this.ppqn} msec/qn`
    );

    this.startTime = this.time;
    this.nextPulseNum = 0;

    this.handleInterval();
    this.intervalId = setInterval(this.handleInterval, this.pulseIntervalMsec);
    // this.link.startUpdate(60, (beat: any, phase: any, bpm: any) => {
    //     console.log("updated: ", beat, phase, bpm);
    // });
  }

  handleInterval = () => {
    this.time = WebMidi.time;
    const elapsedMsec = this.time - this.startTime;
    // const pulseCount = elapsedMsec / this.pulseIntervalMsec;

    this.currentSpp = Math.floor(
      ((this.getElapsedMsec() / this.pulseIntervalMsec) * 16) / this.ppqn
    );
    if (this.loopSpp !== 0 && this.currentSpp > this.loopSpp) {
      this.currentSpp = this.loopSpp;
      this.sendSpp(this.currentSpp);
    }

    if (
      this.time >
      this.startTime + this.nextPulseNum * this.pulseIntervalMsec
    ) {
      // console.log(`send clock pulse ${this.nextPulseNum} at ${Math.floor(this.time - this.startTime)}`)
      this.sendClock(this.nextPulseNum);
      this.eventsEmitter.emit('MIDI pulse', {
        time: elapsedMsec,
        ticks: this.nextPulseNum,
      });

      this.lastTickTime = this.time;

      ++this.nextPulseNum;
    }
  };

  sendStart = () => {
    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      // console.log(`Preferences.getMidiOutputs: ${JSON.stringify(output)}`)
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        // console.log(`TempoService.sendStart: to ${output.name}`)
        output.sendStart();
      }
    });
  };

  sendStop = () => {
    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendStop();
      }
    });
  };

  sendContinue = () => {
    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendContinue();
      }
    });
  };

  // Panic button?
  sendReset = () => {
    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
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
    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
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

    const midiDevicePreferences: MidiDevicePreferences =
      usePreferencesStore.getState().midiDevicePreferences;
    WebMidi.outputs.forEach((output) => {
      // console.log(`Preferences.getMidiOutputs: ${JSON.stringify(output)}`)
      if (midiDevicePreferences.isSyncEnabledForMidiOutputId(output.id)) {
        output.sendSongPosition(spp);
      }
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
    const elapsed64ths = Math.floor(
      ((this.getElapsedMsec() / 60000) * this.bpm * 64) / 4
    );
    // const elapsed64ths = this.getElapsedMsec() / this.pulseIntervalMsec / this.ppqn * 16
    // console.log(`getElapsed64ths: msec ${Math.floor(this.getElapsedMsec())} -> getElapsed64ths ${elapsed64ths} at bpm ${this.bpm}`)
    return elapsed64ths;
  }

  start() {
    this.startTime = this.time;
    this.currentSpp = this.startSpp;
    this.eventsEmitter.emit('SPP', { spp: this.currentSpp });
    this.isRunning = true;
    this.eventsEmitter.emit('stateChange', { isRunning: this.isRunning });
    this.sendStart();
    this.startIntervalTimer();
  }

  continue() {
    this.isRunning = true;
    this.eventsEmitter.emit('stateChange', { isRunning: this.isRunning });
    this.sendContinue();
    this.startIntervalTimer();
  }

  stop() {
    this.isRunning = false;
    this.stopIntervalTimer();
    this.sendStop();
    this.currentSpp = this.startSpp;
    this.eventsEmitter.emit('SPP', { spp: this.currentSpp });
    this.eventsEmitter.emit('stateChange', { isRunning: this.isRunning });
  }
}

export default new TempoService();
