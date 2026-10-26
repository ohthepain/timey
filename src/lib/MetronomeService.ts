import { midiService } from '~/lib/MidiService';
import { metronomeTickNote } from '~/lib/metronomePulse';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { TempoService } from '~/lib/TempoService';

class MetronomeService {
  private static _instance: MetronomeService | null = null;

  private constructor() {
    // Listen for start/stop events from MidiService or TempoService
    this.tempoService.eventsEmitter.addListener('start', this.handleStart);
    this.tempoService.eventsEmitter.addListener('stop', this.handleStop);
    this.tempoService.eventsEmitter.addListener('midiClockPulse', this.handlePulse);
  }

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  static getInstance() {
    if (!MetronomeService._instance) {
      MetronomeService._instance = new MetronomeService();
    }
    return MetronomeService._instance;
  }

  public static shutdown() {
    if (MetronomeService._instance) {
      MetronomeService._instance.destroy();
      MetronomeService._instance = null;
    }
  }

  destroy() {
    this.tempoService.eventsEmitter.removeListener('start', this.handleStart);
    this.tempoService.eventsEmitter.removeListener('stop', this.handleStop);
    this.tempoService.eventsEmitter.removeListener('midiClockPulse', this.handlePulse);
  }

  private handleStart = () => {};

  private handleStop = () => {};

  private handlePulse = (event: { time: number; ticks: number }) => {
    const note = metronomeTickNote(this.tempoService, event.ticks);
    if (note === null) return;
    const velocity = useMidiSettingsStore.getState().metronomeVelocity;
    midiService.playNote(note, velocity);
  };
}

const metronomeService = MetronomeService.getInstance();
