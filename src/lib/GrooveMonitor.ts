import { EventEmitter } from 'events';
import TempoService from '~/lib/MidiSync/TempoService';
import { midiService } from './MidiService';
import type { BeatNote } from '~/types/BeatNote';
import type { Performance } from '~/types/Performance';
import { beatPlayer } from './BeatPlayer';

class GrooveMonitor extends EventEmitter {
  private _isRunning: boolean;
  private performance: Performance = new Performance();

  constructor() {
    super();
    this._isRunning = false;

    TempoService.eventsEmitter.addListener('start', this.handlePlay.bind(this));
    TempoService.eventsEmitter.addListener('stop', this.handleStop.bind(this));
    TempoService.eventsEmitter.addListener('MIDI pulse', (event) => this.handleMidiPulse(event));

    midiService.addListener('MIDI pulse', (event) => this.handleMidiPulse(event));
    midiService.addListener('note', this.handleNote.bind(this));

    beatPlayer.addListener('note', this.handleNote.bind(this));
    beatPlayer.addListener('play', this.handlePlay.bind(this));
    beatPlayer.addListener('stop', this.handleStop.bind(this));
  }

  private handlePlay() {
    console.log('GrooveMonitor: handlePlay');
    if (this._isRunning) return;

    this._isRunning = true;
  }

  private handleStop() {
    console.log('GrooveMonitor: handleStop');
    if (!this._isRunning) return;
  }

  private handleMidiPulse(event: { time: number; ticks: number }) {
    console.log('GrooveMonitor: handleMidiPulse', event);
    if (!this._isRunning || !TempoService.startTime) {
      return;
    }

    // Handle the MIDI pulse event
  }

  private handleNote(note: BeatNote) {
    console.log('GrooveMonitor: handleNote', note);
    if (!this._isRunning) return;

    // Handle the note event
  }
}
