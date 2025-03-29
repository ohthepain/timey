import { EventEmitter } from 'events';
import TempoService from '~/lib/MidiSync/TempoService';
import { useScoreStore } from '~/state/ScoreStore';
import { NoteEntry, MakeStaveNotes } from '~/lib/ParseBeat';

class BeatPlayer extends EventEmitter {
  private allNotes: NoteEntry[] = [];
  private noteIndex: number = 0;
  private nextNoteStartTime: number = 0;
  private numLoops: number = 0;

  constructor() {
    super();

    // Subscribe to TempoService events
    console.log(`BeatPlayer:ctor - add listeners`);
    TempoService.eventsEmitter.addListener('start', this.handleStart.bind(this));
    TempoService.eventsEmitter.addListener('stop', this.handleStop.bind(this));
    TempoService.eventsEmitter.addListener('MIDI pulse', this.handleMidiPulse.bind(this));
  }

  public loadBeat(beatName: string) {
    const beatString = useScoreStore.getState().getBeat(beatName);
    if (!beatString) {
      throw new Error(`Beat "${beatName}" not found in the store.`);
    }

    const { noteEntries } = MakeStaveNotes(beatString);
    this.allNotes = noteEntries;
    this.noteIndex = 0;
    this.numLoops = 0;
    this.nextNoteStartTime = this.allNotes[0].getStartTimeMsec(TempoService.bpm);
  }

  private handleStart() {
    console.log('BeatPlayer: handlePlay');
    this.noteIndex = 0;
    this.numLoops = 0;
  }

  private handleStop() {
    console.log('BeatPlayer: handleStop');
    this.noteIndex = 0;
  }

  private handleMidiPulse(currentTime: number) {
    if (!TempoService.isRunning || !TempoService.startTime) {
      return;
    }

    const elapsedTime = TempoService.time - TempoService.startTime;

    const lastNote = this.allNotes[this.allNotes.length - 1];
    const loopLengthMsec = ((lastNote.barNum + 1) * 4 * 60 * 1000) / TempoService.bpm;
    // this.nextNoteStartTime += loopLengthMsec * this.numLoops;

    if (elapsedTime >= this.nextNoteStartTime) {
      console.log(
        `BeatPlayer: nextNoteStartTime at ${this.nextNoteStartTime} elapsedTime ${elapsedTime} this.numLoops ${this.numLoops}`
      );
      this.emit('note', this.noteIndex);
      this.noteIndex++;
      if (this.noteIndex >= this.allNotes.length) {
        this.noteIndex = 0;
        this.numLoops++;
      }
      const nextNote = this.allNotes[this.noteIndex];

      this.nextNoteStartTime = nextNote.getStartTimeMsec(TempoService.bpm) + loopLengthMsec * this.numLoops;
      console.log(
        `nextNoteStartTime: ${this.nextNoteStartTime} = ${nextNote.getStartTimeMsec(TempoService.bpm)} + ${loopLengthMsec} * ${this.numLoops}`
      );
      if (!nextNote) {
        throw new Error('No more notes to play.');
      }
    } else {
      // console.log(
      //   `elapsedTime ${elapsedTime} nextNoteStartTime ${this.nextNoteStartTime} numLoops ${this.numLoops} noteIndex ${this.noteIndex}`
      // );
    }
  }

  public destroy() {
    console.log('BeatPlayer: destroy');
    TempoService.eventsEmitter.removeListener('MIDI pulse', this.handleMidiPulse.bind(this));
    TempoService.eventsEmitter.removeListener('play', this.handleStart.bind(this));
    TempoService.eventsEmitter.removeListener('stop', this.handleStop.bind(this));
  }
}

// Create a singleton instance
export const beatPlayer = new BeatPlayer();
