import { midiService } from '~/lib/MidiService';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { useNavigationStore } from '~/state/NavigationStore';
import { tempoService } from '~/lib/MidiSync/TempoService';

class MetronomeService {
  private static _instance: MetronomeService;

  private constructor() {
    // Listen for start/stop events from MidiService or TempoService
    tempoService.eventsEmitter.addListener('start', this.handleStart);
    tempoService.eventsEmitter.addListener('stop', this.handleStop);
    tempoService.eventsEmitter.addListener('MIDI Clock Pulse', this.handlePulse);
  }

  static getInstance() {
    if (!MetronomeService._instance) {
      MetronomeService._instance = new MetronomeService();
    }
    return MetronomeService._instance;
  }

  private handleStart = () => {};

  private handleStop = () => {};

  private handlePulse = (event: { time: number; ticks: number }) => {
    if (!tempoService.isRunning || !useNavigationStore.getState().isMetronomeOn) {
      return;
    }

    // Only play on quarter note ticks
    const ppqn = tempoService.ppqn;
    if (event.ticks % ppqn !== 0) {
      return;
    }

    const midiSettings = useMidiSettingsStore.getState();
    if (!midiSettings.midiOutputDeviceId) {
      return;
    }

    midiService.playNote(midiSettings.metronomeNoteNumber, midiSettings.metronomeVelocity);
  };

  destroy() {
    tempoService.eventsEmitter.removeListener('start', this.handleStart);
    tempoService.eventsEmitter.removeListener('stop', this.handleStop);
    tempoService.eventsEmitter.removeListener('MIDI Clock Pulse', this.handlePulse);
  }
}

export const metronomeService = MetronomeService.getInstance();
