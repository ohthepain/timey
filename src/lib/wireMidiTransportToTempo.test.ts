import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { emitter } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return { emitter: new EventEmitter() };
});

vi.mock('~/lib/MidiService', () => ({
  midiService: emitter,
}));

import { TempoService } from '~/lib/TempoService';
import { MIDI_CLOCK_LOST, MIDI_CLOCK_PULSE } from '~/lib/midiClockEvents';
import { configureMidiTransportPolicy } from '~/lib/midiTransportPolicy';
import { SLAVE_TRANSPORT_COMMAND } from '~/lib/slaveTransportCommand';
import { wireMidiTransportToTempo } from '~/lib/wireMidiTransportToTempo';

describe('wireMidiTransportToTempo', () => {
  let tempo: TempoService;
  let externalClock: boolean;

  beforeEach(() => {
    tempo = TempoService.getInstance();
    externalClock = false;
    configureMidiTransportPolicy({
      followSlaveTransportCommands: () => true,
      setExternalMidiClock: (active) => {
        externalClock = active;
      },
    });
    wireMidiTransportToTempo(tempo);
  });

  afterEach(() => {
    emitter.removeAllListeners();
    TempoService.shutdown();
  });

  it('applies slave transport commands on TempoService', () => {
    emitter.emit(SLAVE_TRANSPORT_COMMAND, 'record');
    expect(tempo.isRecording).toBe(true);
    emitter.emit(SLAVE_TRANSPORT_COMMAND, 'stop');
    expect(tempo.isRunning).toBe(false);
  });

  it('forwards external clock pulses and loss through policy and tempo', () => {
    const pulseSpy = vi.spyOn(tempo, 'handleMidiClockPulse');
    const stopTimerSpy = vi.spyOn(tempo, 'stopIntervalTimer');
    tempo.record();
    emitter.emit(MIDI_CLOCK_PULSE, { now: 2000, bpm: 120, ppqn: 24 });
    expect(externalClock).toBe(true);
    expect(stopTimerSpy).toHaveBeenCalled();
    expect(pulseSpy).toHaveBeenCalled();

    const startTimerSpy = vi.spyOn(tempo, 'startIntervalTimer');
    emitter.emit(MIDI_CLOCK_LOST);
    expect(externalClock).toBe(false);
    expect(startTimerSpy).toHaveBeenCalled();
  });
});
