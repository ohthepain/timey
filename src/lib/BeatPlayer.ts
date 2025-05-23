import { EventEmitter } from 'events';
import { TempoService } from '~/lib/TempoService';
import { NoteEntry, ConvertNoteToMidiNote } from '~/lib/ParseBeat';
import { midiService } from '~/lib/MidiService';
import { useNavigationStore } from '~/state/NavigationStore';
import { Beat } from '~/types/Beat';
import { MakeStaveNotesFromBeat } from '~/lib/ParseBeat';

class BeatPlayer extends EventEmitter {
  private beat: Beat | null = null;
  private allNotes: NoteEntry[] = [];
  private isPlaying: boolean = false;
  private noteIndex: number = 0;
  private nextNoteStartMsec: number = 0;
  private numLoops: number = 0;

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  constructor() {
    super();

    // Subscribe to TempoService events
    console.log(`BeatPlayer:ctor - add listeners`);
    this.tempoService.eventsEmitter.addListener('stateChange', this.tempoService_stateChange);
    this.tempoService.eventsEmitter.addListener('MIDI Clock Pulse', this.handleMidiPulse);
  }

  public destroy() {
    console.log('BeatPlayer: destroy');
    this.tempoService.eventsEmitter.removeListener('MIDI Clock Pulse', this.handleMidiPulse);
    this.tempoService.eventsEmitter.removeListener('stateChange', this.tempoService_stateChange);
  }

  public setBeat(beat: Beat) {
    console.log('BeatPlayer: setBeat');
    this.beat = beat;

    useNavigationStore.getState().setCurrentBeat(this.beat);
    const { noteEntries } = MakeStaveNotesFromBeat(this.beat);
    this.allNotes = noteEntries;

    this.noteIndex = 0;
    this.numLoops = 0;
    this.nextNoteStartMsec = 0;
  }

  private tempoService_stateChange = (e: any) => {
    console.log(`BeatPlayer: tempoService_stateChange playing ${e.isPlaying} running ${e.isRunning}`);
    if (this.isPlaying != (e.isPlaying && e.isRunning)) {
      this.noteIndex = 0;
      this.numLoops = 0;
      this.nextNoteStartMsec = 0;
      this.isPlaying = e.isPlaying && e.isRunning;
    }
  };

  private handleMidiPulse = (event: { time: number; ticks: number }) => {
    if (!this.beat) {
      console.log('BeatPlayer: handleMidiPulse - no beat');
      return;
    }

    if (!this.tempoService.isRunning || !this.tempoService.isPlaying) {
      return;
    }

    if (this.allNotes.length === 0) {
      console.log('BeatPlayer: handleMidiPulse - no notes to play');
      return;
    }

    const elapsedMsec = this.tempoService.elapsedMsec;
    const loopLengthMsec = this.beat?.getLoopLengthMsec(this.tempoService.bpm);

    if (elapsedMsec >= this.nextNoteStartMsec) {
      let notes: number[] = [];
      for (const note of this.allNotes[this.noteIndex].keys) {
        const midiNote = ConvertNoteToMidiNote(note);
        if (midiNote) {
          notes.push(midiNote);
        }
      }
      // console.log(`BeatPlayer: handleMidiPulse - notes: `, notes);
      if (this.isPlaying) {
        midiService.playNote(notes, 127, 0, 0);
        this.emit('note', this.noteIndex);
      }

      this.noteIndex++;
      if (this.noteIndex >= this.allNotes.length) {
        this.noteIndex = 0;
        this.numLoops++;
      }
      const nextNote = this.allNotes[this.noteIndex];

      // TODO: This won't handle tempo changes well. Calculate the amount of time to the next note relatively
      this.nextNoteStartMsec = nextNote.getStartPositionMsec(this.tempoService.bpm) + loopLengthMsec * this.numLoops;
      if (!nextNote) {
        throw new Error('No more notes to play.');
      }
    }
  };
}

// Create a singleton instance
export const beatPlayer = new BeatPlayer();
