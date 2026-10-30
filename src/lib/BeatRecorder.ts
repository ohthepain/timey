import { EventEmitter } from 'events';
import { midiService } from '~/lib/MidiService';
import { v4 as uuidv4 } from 'uuid';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';
import { privatePractice } from '~/state/privatePractice';
import { fetchUserPerformancesForBeatServerFn, savePerformanceServerFn } from '~/services/performanceService';
import { useNavigationStore } from '~/state/NavigationStore';
import { PerformanceFeedback, BeatNoteFeedback } from './PerformanceFeedback';
import { TempoService } from '~/lib/TempoService';
import { EventRecorderService } from './EventRecorderService';
import type { EventPosition } from './EventRecorderService';

// Helper to quantize a time to the nearest 32nd note
function quantizeTo32nd(elapsedMsec: number, bpm: number) {
  // 1 quarter note = 60,000 / bpm ms
  // 1 32nd note = quarterNoteMsec / 8
  const quarterNoteMsec = 60000 / bpm;
  const thirtySecondMsec = quarterNoteMsec / 8;
  const quantized = Math.round(elapsedMsec / thirtySecondMsec) * thirtySecondMsec;
  return { quantized, thirtySecondMsec };
}

export class BeatRecorder extends EventEmitter {
  private static _instance: BeatRecorder | null = null;
  public beat: Beat | null = null;
  // Note: setBeat must reset entire object state
  public performance: Performance = new Performance({ beatId: 'no beat!' });
  public performanceFeedback: PerformanceFeedback = new PerformanceFeedback([]);
  private currentNoteIndex: number = 0;
  private playedNotesForCurrentIndex: string[] = [];

  private get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  public static getInstance(): BeatRecorder {
    if (!BeatRecorder._instance) {
      BeatRecorder._instance = new BeatRecorder();
    }
    return BeatRecorder._instance;
  }

  public static shutdown() {
    if (BeatRecorder._instance) {
      BeatRecorder._instance.destroy();
      BeatRecorder._instance = null;
    }
  }

  private constructor() {
    console.log('BeatRecorder: constructor');
    super();

    if (typeof window !== 'undefined') {
      if (!midiService) {
        throw new Error('midiService is not initialized');
      }
      midiService.on('midiNote', this.midiService_midiNote);
      this.tempoService.eventsEmitter.addListener('stateChange', this.tempoService_stateChange);
      this.tempoService.eventsEmitter.addListener('midiClockPulse', this.tempoService_midiPulse);
    }
  }

  destroy() {
    console.log('BeatRecorder: destroy');
    if (typeof window !== 'undefined') {
      midiService.removeListener('midiNote', this.midiService_midiNote);
      this.tempoService.eventsEmitter.removeListener('stateChange', this.tempoService_stateChange);
      this.tempoService.eventsEmitter.removeListener('midiClockPulse', this.tempoService_midiPulse);
    }
  }

  public setBeat(beat: Beat) {
    console.log('BeatRecorder: setBeat', beat.id);
    this.beat = beat;
    // Must reset entire object state when we set a new beat
    this.performance = new Performance({ beatId: 'no beat!' });
    this.performanceFeedback = new PerformanceFeedback([]);
    this.currentNoteIndex = 0;
    this.playedNotesForCurrentIndex = [];

    this.start();
  }

  async savePerformance() {
    console.log('BeatRecorder: savePerformance', this.performance);
    if (!this.performance) {
      alert('No performance to save');
      return;
    }

    const recording = {
      beatId: this.performance.beatId,
      index: this.performance.index,
      notes: this.performance.notes.map((note) => note.toJSON()),
    };
    const saved = await privatePractice(async () => {
      await savePerformanceServerFn({ data: { performance: recording } });
      return fetchUserPerformancesForBeatServerFn({ data: { beatId: recording.beatId } });
    });
    if (saved) {
      useNavigationStore.getState().clearPerformancesForBeatId(recording.beatId);
      saved.forEach((performance) => useNavigationStore.getState().cachePerformance(new Performance(performance)));
    }
  }

  replay() {
    const beat = this.beat;
    if (!beat) throw new Error('Select a beat before replaying.');
    const tempo = this.tempoService;
    tempo.replay(() => {
      this.setBeat(beat);
      EventRecorderService.getInstance().replay({
        advanceTime: tempo.simulateInterval,
        emitMidiNote: (note, velocity) => midiService.emitMidiNote(note, velocity),
      });
    });
  }

  private get eventPosition(): EventPosition {
    return { noteIndex: this.currentNoteIndex, timestamp: this.tempoService.elapsedMsec };
  }

  private tempoService_stateChange = (state: any) => {
    if (state.isRunning && state.isRecording) {
      this.start();
    } else {
      this.stop();
    }
  };

  public start = () => {
    const beatId = this.beat!.id!;
    console.log('BeatRecorder: start', beatId);
    this.performance = new Performance({ beatId });
    this.performanceFeedback = new PerformanceFeedback([]);
    this.currentNoteIndex = 0;
  };

  public stop = () => {
    console.log('BeatRecorder: stop');
    console.log('BeatRecorder: performanceFeedback', this.performanceFeedback?.beatNoteFeedback);
  };

  private findUnplayedNotes(currentBeatNote: BeatNote, playedNotes: string[]): string[] {
    // Parse the noteString to get expected notes
    const expectedNotes = currentBeatNote.noteString
      .replace(/[\[\]]/g, '') // Remove brackets
      .split(',')
      .map((note) => note.trim());

    // Return strings in expectedNotes that do not appear in playedNotes
    const unplayedNotes = expectedNotes.filter((expectedNote) => !playedNotes.includes(expectedNote));
    return unplayedNotes;
  }

  // Once we have passed a note, check if any notes were missed. if so, emit a missedNotes event
  private checkUnplayedNotes = () => {
    const currentBeatNote: BeatNote = this.beat!.beatNotes[this.currentNoteIndex];
    const unplayedNotes = this.findUnplayedNotes(currentBeatNote, this.playedNotesForCurrentIndex);
    if (unplayedNotes.length > 0) {
      console.log('Missed notes:', unplayedNotes);
      const beatNoteFeedback = new BeatNoteFeedback({
        beat: this.beat,
        index: this.currentNoteIndex,
        beatNote: currentBeatNote,
        missedNotes: unplayedNotes,
      });
      this.performanceFeedback.beatNoteFeedback.push(beatNoteFeedback);
      EventRecorderService.getInstance().recordMissedNotes(beatNoteFeedback, this.eventPosition);
      this.emit('missedNotes', beatNoteFeedback);
    }
  };

  private tempoService_midiPulse = (event: { time: number; ticks: number; intervalMsec: number }) => {
    // Capture the pulse before advancing the note index, matching live/replay CSV ordering.
    EventRecorderService.getInstance().recordTimingPulse(event.intervalMsec, this.eventPosition);
    if (this.beat && this.tempoService.isRecording) {
      const elapsedMsec = this.tempoService.elapsedMsec;
      const position = elapsedMsec % this.beat.getLoopLengthMsec(this.tempoService.bpm);
      const nextNoteIndex = (this.currentNoteIndex + 1) % this.beat.beatNotes.length;
      const nextBeatNote = this.beat.beatNotes[nextNoteIndex];
      const nextBeatNoteTime = nextBeatNote.getPositionMsec(this.tempoService.bpm);

      // Special case for the last note: check if we're at the end of the beat
      const isLastNote = this.currentNoteIndex === this.beat.beatNotes.length - 1;
      const shouldAdvance = isLastNote
        ? position < 100 // If we're at the last note, advance when we're near the start of the loop
        : position >= nextBeatNoteTime; // Otherwise, advance when we pass the next note's time

      if (shouldAdvance) {
        this.advanceToNextIndex();
      }
    }
  };

  private hasReachedCurrentIndex(): boolean {
    if (!this.beat) return false;
    const elapsedMsec = this.tempoService.elapsedMsec;
    const position = elapsedMsec % this.beat.getLoopLengthMsec(this.tempoService.bpm);
    const currentBeatNote = this.beat.beatNotes[this.currentNoteIndex];
    const currentBeatNoteTime = currentBeatNote.getPositionMsec(this.tempoService.bpm);

    // Special case for the last note: we've reached it if we're near the start of the loop
    const isLastNote = this.currentNoteIndex === this.beat.beatNotes.length - 1;
    if (isLastNote) {
      return position >= currentBeatNoteTime || position < 100; // If we're at the last note, we've reached it when we're near the start of the loop
    }

    return position >= currentBeatNoteTime;
  }

  private advanceToNextIndex = () => {
    if (!this.hasReachedCurrentIndex()) {
      throw new Error(
        `Cannot advance to next index before reaching current note's start time. Current position: ${this.tempoService.elapsedMsec % this.beat!.getLoopLengthMsec(this.tempoService.bpm)}ms, Note start time: ${this.beat!.beatNotes[this.currentNoteIndex].getPositionMsec(this.tempoService.bpm)}ms`
      );
    }

    this.checkUnplayedNotes();
    this.currentNoteIndex = (this.currentNoteIndex + 1) % this.beat!.beatNotes.length;
    this.playedNotesForCurrentIndex = [];
  };

  private makeBeatNote = (note: number, velocity: number) => {
    const bpm = this.tempoService.bpm;
    const elapsedMsec = this.tempoService.elapsedMsec;
    const { quantized, thirtySecondMsec } = quantizeTo32nd(elapsedMsec, bpm);
    // Calculate position in the bar
    const quarterNoteMsec = 60000 / bpm;
    const barLengthMsec = quarterNoteMsec * 4;
    const barNum = Math.floor(quantized / barLengthMsec);
    const barElapsed = quantized - barNum * barLengthMsec;
    const beatNum = Math.floor(barElapsed / quarterNoteMsec);
    const beatElapsed = barElapsed - beatNum * quarterNoteMsec;
    const divisionNum = Math.floor(beatElapsed / (quarterNoteMsec / 2)); // 8th note
    const divisionElapsed = beatElapsed - divisionNum * (quarterNoteMsec / 2);
    // Find best subdivision (16th, 32nd, triplets, etc)
    // We'll use 32nd notes as max resolution
    const subDivisionDurations = [2, 3, 4, 6, 8]; // 2=8th, 3=triplet, 4=16th, 6=16th triplet, 8=32nd
    let bestSubDiv = 8;
    let bestSubDivNum = 0;
    let minError = Infinity;
    for (const numSubDivisions of subDivisionDurations) {
      const subDivMsec = quarterNoteMsec / 2 / numSubDivisions;
      for (let subDivNum = 0; subDivNum < numSubDivisions; subDivNum++) {
        const ideal = subDivNum * subDivMsec;
        const error = Math.abs(divisionElapsed - ideal);
        if (error < minError) {
          minError = error;
          bestSubDiv = numSubDivisions;
          bestSubDivNum = subDivNum;
        }
      }
    }

    const noteString = String(note);

    const playedNote = new BeatNote({
      id: uuidv4(),
      index: this.currentNoteIndex, // TODO: This will be wrong if we advance to the next index below
      noteString,
      barNum,
      beatNum,
      divisionNum,
      subDivisionNum: bestSubDivNum,
      numSubDivisions: bestSubDiv,
      velocity: velocity,
      microtiming: divisionElapsed - bestSubDivNum * (quarterNoteMsec / 2 / bestSubDiv),
    });

    return playedNote;
  };

  private WasNotePlayedForCurrentIndex(note: number): boolean {
    const matchedNote = this.beat!.beatNotes[this.currentNoteIndex].matchMidiNote(note);
    if (!matchedNote) {
      return false;
    }
    return this.playedNotesForCurrentIndex.includes(matchedNote);
  }

  private matchCurrentOrNextNote(beat: Beat, note: number): BeatNote | null {
    const current = beat.beatNotes[this.currentNoteIndex];
    if (current.matchMidiNote(note) && !this.WasNotePlayedForCurrentIndex(note)) {
      return current;
    }
    const next = beat.beatNotes[(this.currentNoteIndex + 1) % beat.beatNotes.length];
    // Repeated notes can advance only after reaching the current interval.
    if (next.matchMidiNote(note) && this.hasReachedCurrentIndex()) {
      this.advanceToNextIndex();
      return next;
    }
    return null;
  }

  private midiService_midiNote = (e: any) => {
    if (!this.tempoService.isRecording || !this.beat) {
      return;
    }

    if (e.note === 75) {
      // Ignore metronome
      return;
    }

    // Record the raw MIDI note input immediately
    EventRecorderService.getInstance().recordMidiNote(e.note, e.velocity, this.eventPosition);

    const playedNote = this.makeBeatNote(e.note, e.velocity);
    this.performance.notes.push(playedNote);

    const elapsedMsec = this.tempoService.elapsedMsec;
    const bpm = this.tempoService.bpm;

    const position = elapsedMsec % this.beat.getLoopLengthMsec(bpm);
    const currentBeatNote = this.matchCurrentOrNextNote(this.beat, e.note);
    if (!currentBeatNote) {
      console.log('BeatRecorder: handleMidiNote - extra note', playedNote);
      EventRecorderService.getInstance().recordExtraNote(e.note, this.eventPosition);
      return;
    }

    // Add the note to playedNotesForCurrentIndex if it's expected in the current beat note
    const matchedNote: string | null = currentBeatNote.matchMidiNote(e.note);
    if (matchedNote) {
      this.playedNotesForCurrentIndex.push(matchedNote);
    }

    const beatNoteFeedback = this.performanceFeedback.addBeatNote(
      this.beat,
      playedNote,
      this.currentNoteIndex,
      position,
      e.note,
      bpm
    );

    if (beatNoteFeedback) {
      EventRecorderService.getInstance().recordNoteFeedback(
        parseInt(playedNote.noteString),
        beatNoteFeedback.timingDifferenceMs || 0,
        beatNoteFeedback.velocityDifference || 0,
        this.eventPosition
      );
      this.emit('beatNoteFeedback', beatNoteFeedback);
    } else {
      console.log('BeatRecorder: handleMidiNote - no match', playedNote);
      // Record as extra note if it doesn't match any expected note
      EventRecorderService.getInstance().recordExtraNote(e.note, this.eventPosition);
    }

    this.emit('beatNote', beatNoteFeedback);
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    BeatRecorder.getInstance().destroy();
  });
}
