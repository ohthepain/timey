import { EventEmitter } from 'events';
import TempoService from '~/lib/MidiSync/TempoService';
import { NoteEntry, ConvertNoteToMidiNote } from '~/lib/ParseBeat';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { midiService } from '~/lib/MidiService';
import { useNavigationStore } from '~/state/NavigationStore';
import { Beat } from '~/types/Beat';
import { MakeStaveNotesFromBeat } from '~/lib/ParseBeat';

class BeatPlayer extends EventEmitter {
  private isPlaying: boolean = false;
  private allNotes: NoteEntry[] = [];
  private noteIndex: number = 0;
  private nextNoteStartTime: number = 0;
  private numLoops: number = 0;

  constructor() {
    super();

    // Subscribe to TempoService events
    console.log(`BeatPlayer:ctor - add listeners`);
    TempoService.eventsEmitter.addListener('stateChange', this.tempoService_stateChange);
    TempoService.eventsEmitter.addListener('MIDI pulse', this.handleMidiPulse);
  }

  public destroy() {
    console.log('BeatPlayer: destroy');
    TempoService.eventsEmitter.removeListener('MIDI pulse', this.handleMidiPulse);
    TempoService.eventsEmitter.removeListener('stateChange', this.tempoService_stateChange);
  }

  public setBeat(beat: Beat) {
    console.log('BeatPlayer: setBeat');

    useNavigationStore.getState().setCurrentBeat(beat);
    const { noteEntries } = MakeStaveNotesFromBeat(beat);
    this.allNotes = noteEntries.map((noteEntry) => noteEntry);
    console.log(`BeatPlayer: allNotes: `, this.allNotes);

    this.noteIndex = 0;
    this.numLoops = 0;
    this.nextNoteStartTime = 0;

    // Emit an event to notify that the beat has been set
    this.emit('beatSet', beat);
  }

  private tempoService_stateChange = (e: any) => {
    console.log(`BeatPlayer: tempoService_stateChange playing ${e.isPlaying} running ${e.isRunning}`);
    if (this.isPlaying != (e.isPlaying && e.isRunning)) {
      this.noteIndex = 0;
      this.numLoops = 0;
      this.nextNoteStartTime = 0;
      this.isPlaying = e.isPlaying && e.isRunning;
    }
  };

  private handleMidiPulse = (event: { time: number; ticks: number }) => {
    if (!TempoService.isRunning || !TempoService.isPlaying) {
      return;
    }

    if (!TempoService.startTime) {
      throw new Error('TempoService.startTime is not set');
    }

    if (this.allNotes.length === 0) {
      console.log('BeatPlayer: handleMidiPulse - no notes to play');
      return;
    }

    const elapsedTime = TempoService.time - TempoService.startTime;
    const lastNote = this.allNotes[this.allNotes.length - 1];
    const loopLengthMsec = ((lastNote.barNum + 1) * 4 * 60 * 1000) / TempoService.bpm;
    // this.nextNoteStartTime += loopLengthMsec * this.numLoops;

    if (elapsedTime >= this.nextNoteStartTime) {
      const { midiOutputDeviceId, midiOutputChannelNum } = useMidiSettingsStore.getState();
      let notes: number[] = [];
      for (const note of this.allNotes[this.noteIndex].keys) {
        const midiNote = ConvertNoteToMidiNote(note);
        if (midiNote) {
          notes.push(midiNote);
        }
      }
      // console.log(`BeatPlayer: handleMidiPulse - notes: `, notes);
      if (this.isPlaying) {
        midiService.playNote(midiOutputDeviceId, midiOutputChannelNum, notes, 127, 0, 0);
        this.emit('note', this.noteIndex);
      }

      this.noteIndex++;
      if (this.noteIndex >= this.allNotes.length) {
        this.noteIndex = 0;
        this.numLoops++;
      }
      const nextNote = this.allNotes[this.noteIndex];

      // TODO: This won't handle tempo changes well. Calculate the amount of time to the next note relatively
      this.nextNoteStartTime = nextNote.getStartTimeMsec(TempoService.bpm) + loopLengthMsec * this.numLoops;
      if (!nextNote) {
        throw new Error('No more notes to play.');
      }
    }
  };
}

// Create a singleton instance
export const beatPlayer = new BeatPlayer();
