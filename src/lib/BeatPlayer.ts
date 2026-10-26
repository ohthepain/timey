import { EventEmitter } from 'events';
import { TempoService } from '~/lib/TempoService';
import { NoteEntry } from '~/lib/ParseBeat';
import { midiService } from '~/lib/MidiService';
import { useNavigationStore } from '~/state/NavigationStore';
import { Beat } from '~/types/Beat';
import { MakeStaveNotesFromBeat } from '~/lib/ParseBeat';
import { advanceNoteIndex, canProcessBeatPulse, midiNotesForEntry, nextScheduleTimeMsec } from '~/lib/beatPlayerPulse';

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
    console.log(`BeatPlayer:ctor - add listeners`);
    this.tempoService.eventsEmitter.addListener('stateChange', this.tempoService_stateChange);
    this.tempoService.eventsEmitter.addListener('midiClockPulse', this.handleMidiPulse);
  }

  public destroy() {
    console.log('BeatPlayer: destroy');
    this.tempoService.eventsEmitter.removeListener('midiClockPulse', this.handleMidiPulse);
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

  private tempoService_stateChange = (e: { isPlaying: boolean; isRunning: boolean }) => {
    console.log(`BeatPlayer: tempoService_stateChange playing ${e.isPlaying} running ${e.isRunning}`);
    const playing = e.isPlaying && e.isRunning;
    if (this.isPlaying === playing) return;
    this.noteIndex = 0;
    this.numLoops = 0;
    this.nextNoteStartMsec = 0;
    this.isPlaying = playing;
  };

  private playDueNote() {
    const entry = this.allNotes[this.noteIndex];
    if (this.isPlaying) {
      midiService.playNote(midiNotesForEntry(entry), 127, 0, 0);
      this.emit('note', this.noteIndex);
    }
    const advanced = advanceNoteIndex(this.noteIndex, this.allNotes.length);
    this.noteIndex = advanced.noteIndex;
    this.numLoops += advanced.numLoopsDelta;
    const nextNote = this.allNotes[this.noteIndex];
    if (!nextNote) throw new Error('No more notes to play.');
    const loopLengthMsec = this.beat!.getLoopLengthMsec(this.tempoService.bpm);
    this.nextNoteStartMsec = nextScheduleTimeMsec(
      nextNote,
      this.tempoService.bpm,
      loopLengthMsec,
      this.numLoops
    );
  }

  private handleMidiPulse = () => {
    const ready = canProcessBeatPulse({
      hasBeat: Boolean(this.beat),
      isRunning: this.tempoService.isRunning,
      isPlaying: this.tempoService.isPlaying,
      noteCount: this.allNotes.length,
      elapsedMsec: this.tempoService.elapsedMsec,
      nextNoteStartMsec: this.nextNoteStartMsec,
    });
    if (!ready) return;
    this.playDueNote();
  };
}

export const beatPlayer = new BeatPlayer();
