import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Transport } from './Transport';
import { TempoService } from '~/lib/TempoService';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { EventRecorderService } from '~/lib/EventRecorderService';
import { createTestBeat } from '~/lib/BeatTestUtil';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';

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
vi.mock('./Metronome', () => ({ Metronome: () => null }));
vi.mock('./TempoInput', () => ({ TempoInput: () => null }));
vi.mock('~/services/performanceService', () => ({
  savePerformanceServerFn: vi.fn(),
  deletePerformancesByBeatIdAndUserId: vi.fn(),
}));

describe('Transport controls with shared state', () => {
  let tempo: TempoService;
  let events: EventRecorderService;
  let fileInput: HTMLInputElement;

  beforeEach(() => {
    vi.useFakeTimers();
    usePersistedStore.setState({ midiSlave: false, devMode: false });
    const beat = createTestBeat();
    useNavigationStore.setState({ currentBeat: beat, performancesByBeatId: {}, practiceUserId: 'transport-fixture' });
    tempo = TempoService.getInstance();
    BeatRecorder.getInstance().setBeat(beat);
    events = EventRecorderService.getInstance();
    events.clear();
    tempo.startSimulatedIntervalTimerForTesting();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      fileInput = this;
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(events, 'saveToCsv').mockImplementation(() => {});
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, 'result', { value: '0,0,midi,kick,,100' });
      this.dispatchEvent(new ProgressEvent('load'));
    });
  });

  afterEach(() => {
    cleanup();
    BeatRecorder.shutdown();
    TempoService.shutdown();
    EventRecorderService.shutdown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps controls synchronized with out-of-band starts, switches and stops', () => {
    render(<Transport />);
    act(() => tempo.record());
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(tempo.isPlaying).toBe(true);
    expect(tempo.isRecording).toBe(false);
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(tempo.isRunning).toBe(false);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(tempo.isRecording).toBe(true);
    act(() => tempo.stop());
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('allows anonymous recording and playback while linking persistence to sign-in', () => {
    useNavigationStore.setState({ practiceUserId: null });
    render(<Transport />);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to save recordings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(tempo.isPlaying).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(tempo.isRecording).toBe(true);
  });

  it('reads current state on mount and releases its subscription on unmount', () => {
    tempo.record();
    const listeners = tempo.eventsEmitter.listenerCount('transportChange');
    const view = render(<Transport />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(tempo.eventsEmitter.listenerCount('transportChange')).toBe(listeners + 1);
    view.unmount();
    expect(tempo.eventsEmitter.listenerCount('transportChange')).toBe(listeners);
  });

  it('offers Stop for an external clock-only Continue', () => {
    render(<Transport />);
    act(() => tempo.continue());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(tempo.isRunning).toBe(false);
  });

  it('leaves transport and recorded events unchanged when file selection is cancelled', () => {
    events.recordMidiNote(36, 100, { noteIndex: 0, timestamp: 0 });
    const before = tempo.getTransportState();
    const csv = events.toCsv();
    render(<Transport />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay (0)' }));
    fireEvent.change(fileInput, { target: { files: [] } });
    expect(tempo.getTransportState()).toBe(before);
    expect(events.toCsv()).toBe(csv);
    expect(FileReader.prototype.readAsText).not.toHaveBeenCalled();
  });

  it('finishes file replay stopped and can immediately start normal recording', () => {
    tempo.isSimulatedTimerForTesting = false;
    render(<Transport />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay (0)' }));
    fireEvent.change(fileInput, { target: { files: [new File(['fixture'], 'take.csv')] } });
    expect(BeatRecorder.getInstance().performance.notes).toHaveLength(1);
    expect(events.saveToCsv).toHaveBeenCalledWith('take-replay.csv');
    expect(tempo.isRunning).toBe(false);
    expect(tempo.isSimulatedTimerForTesting).toBe(false);
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(tempo.isRecording).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not overwrite a practice session started while file selection was open', () => {
    render(<Transport />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay (0)' }));
    act(() => tempo.record());
    const state = tempo.getTransportState();
    fireEvent.change(fileInput, { target: { files: [new File(['fixture'], 'take.csv')] } });
    expect(tempo.getTransportState()).toBe(state);
    expect(window.alert).toHaveBeenCalledWith('Stop practice before replaying.');
    expect(events.saveToCsv).not.toHaveBeenCalled();
  });
});
