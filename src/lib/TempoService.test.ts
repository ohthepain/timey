import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BeatRecorder } from './BeatRecorder';
import { TempoService } from './TempoService';
import { EventRecorderService } from './EventRecorderService';
import { createTestBeat } from './BeatTestUtil';
import { midiService } from './MidiService';
import { usePersistedStore } from '~/state/PersistedStore';
import { usePreferencesStore } from '~/state/PreferencesStore';
import { WebMidi, type Output } from 'webmidi';

vi.mock('webmidi', () => ({ WebMidi: { time: 1000, outputs: [] } }));
vi.mock('~/lib/MidiService', async () => {
  const { EventEmitter } = await import('events');
  const emitter = new EventEmitter();
  return {
    midiService: Object.assign(emitter, {
      emitMidiNote: (note: number, velocity: number) => emitter.emit('midiNote', { note, velocity }),
    }),
  };
});

vi.mock('~/services/performanceService', () => ({
  savePerformanceServerFn: vi.fn(),
  deletePerformancesByBeatIdAndUserId: vi.fn(),
}));

describe('transport ownership', () => {
  let tempo: TempoService;
  let recorder: BeatRecorder;
  let events: EventRecorderService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'setInterval');
    vi.spyOn(globalThis, 'clearInterval');
    usePersistedStore.setState({ midiSlave: false });
    tempo = TempoService.getInstance();
    recorder = BeatRecorder.getInstance();
    recorder.setBeat(createTestBeat());
    events = EventRecorderService.getInstance();
    events.clear();
    tempo.startSimulatedIntervalTimerForTesting();
  });

  afterEach(() => {
    BeatRecorder.shutdown();
    TempoService.shutdown();
    EventRecorderService.shutdown();
    WebMidi.outputs.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('publishes stable, read-only snapshots for play, record and stop; subscriptions release', () => {
    const initial = tempo.getTransportState();
    expect(tempo.getTransportState()).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);
    const states: ReturnType<TempoService['getTransportState']>[] = [];
    const unsubscribe = tempo.subscribeTransportState(() => states.push(tempo.getTransportState()));

    tempo.play();
    tempo.record();
    tempo.stop();

    expect(states).toEqual([
      { isRunning: true, isPlaying: true, isRecording: false, isReplaying: false },
      { isRunning: true, isPlaying: false, isRecording: true, isReplaying: false },
      { isRunning: false, isPlaying: false, isRecording: false, isReplaying: false },
    ]);
    expect(initial.isRunning).toBe(false);
    unsubscribe();
    tempo.play();
    expect(states).toHaveLength(3);
  });

  it('preserves synchronized MIDI output and transport event ordering', () => {
    const messages: string[] = [];
    WebMidi.outputs.push({
      id: 'sync-test',
      sendStart: () => messages.push('start'),
      sendStop: () => messages.push('stop'),
      sendContinue: () => messages.push('continue'),
      sendSongPosition: (position: number) => messages.push(`spp:${position}`),
    } as unknown as Output);
    vi.spyOn(usePreferencesStore.getState().midiDevicePreferences, 'isSyncEnabledForMidiOutputId').mockReturnValue(
      true
    );
    tempo.eventsEmitter.on('start', () => messages.push('event:start'));
    tempo.eventsEmitter.on('stop', () => messages.push('event:stop'));

    tempo.play();
    tempo.continue();
    tempo.stop();

    expect(messages).toEqual([
      'spp:0',
      'event:start',
      'start',
      'spp:0',
      'event:start',
      'continue',
      'spp:0',
      'event:start',
      'start',
      'spp:0',
      'event:stop',
      'stop',
    ]);
    messages.length = 0;
    vi.mocked(usePreferencesStore.getState().midiDevicePreferences.isSyncEnabledForMidiOutputId).mockReturnValue(false);
    tempo.play();
    expect(messages).toEqual(['event:start']);
  });

  it('resets capture once on record through the shared stateChange event', () => {
    const reset = vi.spyOn(recorder, 'start');
    tempo.record();
    expect(reset).toHaveBeenCalledTimes(1);
    midiService.emitMidiNote(36, 100);
    expect(recorder.performance.notes).toHaveLength(1);
    tempo.stop();
    expect(recorder.performance.notes).toHaveLength(1);
    tempo.record();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(recorder.performance.notes).toHaveLength(0);
  });

  it('preserves clock-only Continue and slave-mode timer suppression', () => {
    usePersistedStore.setState({ midiSlave: true });
    tempo.isSimulatedTimerForTesting = false;
    tempo.record();
    expect(tempo.isRecording).toBe(true);
    expect(setInterval).not.toHaveBeenCalled();
    tempo.stop();
    tempo.continue();
    expect(tempo.getTransportState()).toEqual({
      isRunning: true,
      isPlaying: false,
      isRecording: false,
      isReplaying: false,
    });
    expect(setInterval).not.toHaveBeenCalled();
    tempo.stop();
    expect(tempo.isRunning).toBe(false);
  });

  it('replays real captured events, retains scoring, and releases the simulated clock for live practice', () => {
    tempo.record();
    midiService.emitMidiNote(36, 100);
    tempo.simulateInterval(250);
    midiService.emitMidiNote(42, 100);
    midiService.emitMidiNote(49, 90); // Unmatched crash must remain an extra event.
    const expectedCsv = events.toCsv();
    expect(expectedCsv).toContain('250,0,timing,,250,');
    expect(expectedCsv).toContain('250,0,missed,hihat,,');
    expect(expectedCsv).toContain('250,1,extra,crash,,');
    const expectedNotes = recorder.performance.notes.map(({ noteString, microtiming }) => ({
      noteString,
      microtiming,
    }));
    const expectedFeedback = recorder.performanceFeedback.beatNoteFeedback.map((feedback) => ({
      timing: feedback.timingDifferenceMs,
      velocity: feedback.velocityDifference,
      missed: feedback.missedNotes,
    }));
    tempo.stop();
    tempo.isSimulatedTimerForTesting = false;
    const replayStates: boolean[] = [];
    const unsubscribe = tempo.subscribeTransportState(() => replayStates.push(tempo.getTransportState().isReplaying));

    recorder.replay();

    expect(events.toCsv()).toBe(expectedCsv);
    expect(recorder.performance.notes.map(({ noteString, microtiming }) => ({ noteString, microtiming }))).toEqual(
      expectedNotes
    );
    expect(
      recorder.performanceFeedback.beatNoteFeedback.map((feedback) => ({
        timing: feedback.timingDifferenceMs,
        velocity: feedback.velocityDifference,
        missed: feedback.missedNotes,
      }))
    ).toEqual(expectedFeedback);
    expect(replayStates).toContain(true);
    expect(replayStates.at(-1)).toBe(false);
    unsubscribe();
    expect(tempo.isSimulatedTimerForTesting).toBe(false);
    expect(tempo.isRunning).toBe(false);
    expect(setInterval).not.toHaveBeenCalled();
    tempo.record();
    expect(tempo.isRecording).toBe(true);
    expect(setInterval).toHaveBeenCalledTimes(1);
    const liveTimer = vi.mocked(setInterval).mock.results[0].value;
    tempo.stop();
    expect(clearInterval).toHaveBeenCalledWith(liveTimer);
  });

  it('stops and restores clock mode after a replay event fails', () => {
    tempo.isSimulatedTimerForTesting = false;
    expect(() =>
      tempo.replay(() => {
        expect(tempo.isRecording).toBe(true);
        expect(tempo.getTransportState().isReplaying).toBe(true);
        throw new Error('bad replay event');
      })
    ).toThrow('bad replay event');
    expect(tempo.getTransportState()).toEqual({
      isRunning: false,
      isPlaying: false,
      isRecording: false,
      isReplaying: false,
    });
    expect(tempo.isSimulatedTimerForTesting).toBe(false);
    expect(setInterval).not.toHaveBeenCalled();
    tempo.play();
    expect(setInterval).toHaveBeenCalledTimes(1);
  });
});
