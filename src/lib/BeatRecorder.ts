import { EventEmitter } from 'events';
import { midiService } from '~/lib/MidiService';
import { v4 as uuidv4 } from 'uuid';
import { tempoService } from '~/lib/MidiSync/TempoService';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';
import { savePerformanceServerFn, deletePerformancesByBeatIdAndUserId } from '~/services/performanceService.server';
import { useNavigationStore } from '~/state/NavigationStore';
import { PerformanceFeedback, BeatNoteFeedback } from './PerformanceFeedback';
import { should } from 'vitest';

// Helper to quantize a time to the nearest 32nd note
function quantizeTo32nd(elapsedMsec: number, bpm: number) {
  // 1 quarter note = 60,000 / bpm ms
  // 1 32nd note = quarterNoteMsec / 8
  const quarterNoteMsec = 60000 / bpm;
  const thirtySecondMsec = quarterNoteMsec / 8;
  const quantized = Math.round(elapsedMsec / thirtySecondMsec) * thirtySecondMsec;
  return { quantized, thirtySecondMsec };
}

class BeatRecorder extends EventEmitter {
  private static _instance: BeatRecorder;
  public performance: Performance = new Performance({ beatId: 'no beat!' });
  public performanceFeedback: PerformanceFeedback = new PerformanceFeedback([]);
  private referenceTime: number = 0;
  private beat: Beat | null = null;
  private currentNoteIndex: number = 0;
  private playedNotesForCurrentIndex: number[] = [];

  private constructor() {
    console.log('BeatRecorder: constructor');
    super();
    midiService.on('midiNote', this.midiService_midiNote);
    tempoService.eventsEmitter.addListener('stateChange', this.handleStateChange);
    tempoService.eventsEmitter.addListener('MIDI Clock Pulse', this.handleMidiPulse);
  }

  destroy() {
    console.log('BeatRecorder: destroy');
    midiService.removeListener('midiNote', this.midiService_midiNote);
    tempoService.eventsEmitter.removeListener('stateChange', this.handleStateChange);
    tempoService.eventsEmitter.removeListener('MIDI Clock Pulse', this.handleMidiPulse);
  }

  async savePerformance() {
    console.log('BeatRecorder: savePerformance', this.performance);
    if (!this.performance) {
      alert('No performance to save');
      return;
    }

    useNavigationStore.getState().clearPerformancesForBeatId(this.performance.beatId);
    useNavigationStore.getState().cachePerformance(this.performance);
    await savePerformanceServerFn({ data: { performance: this.performance } });
    console.log('Performance saved:', this.performance);
  }

  async deletePerformancesForBeat() {
    console.log('BeatRecorder: deletePerformances');
    const success = await deletePerformancesByBeatIdAndUserId({ data: { performanceId: this.performance?.id } });
    if (success) {
      console.log('BeatRecorder: deletePerformances success', success);
      useNavigationStore.getState().clearPerformancesForBeatId(this.performance!.beatId);
    } else {
      console.log('BeatRecorder: deletePerformances FAILED', success);
    }
  }

  private handleMidiPulse = (event: { time: number; ticks: number }) => {
    // Adjust referenceTime to correct for drift between measured and MIDI time
    // The difference between the expected time and the actual MIDI Clock Pulse time
    const now = tempoService.time;
    const midiTime = event.time;
    const drift = midiTime - now;
    this.referenceTime += drift;

    if (this.beat) {
      const elapsedMsec = tempoService.elapsedMsec;
      const position = elapsedMsec % this.beat.getLoopLengthMsec(tempoService.bpm);
      const currentBeatNote = this.beat.beatNotes[this.currentNoteIndex];
      const nextNoteIndex = (this.currentNoteIndex + 1) % this.beat.beatNotes.length;
      const nextBeatNote = this.beat.beatNotes[nextNoteIndex];
      const nextBeatNoteTime = nextBeatNote.getTimeMsec(tempoService.bpm);

      // Special case for the last note: check if we're at the end of the beat
      const isLastNote = this.currentNoteIndex === this.beat.beatNotes.length - 1;
      const shouldAdvance = isLastNote
        ? position < 100 // If we're at the last note, advance when we're near the start of the loop
        : position >= nextBeatNoteTime; // Otherwise, advance when we pass the next note's time

      if (shouldAdvance) {
        this.checkUnplayedNotes();
        // Go to next note
        this.currentNoteIndex = nextNoteIndex;
        this.playedNotesForCurrentIndex = [];
      }
    }
  };

  public static getInstance(): BeatRecorder {
    if (!BeatRecorder._instance) {
      BeatRecorder._instance = new BeatRecorder();
    }
    return BeatRecorder._instance;
  }

  public setBeat(beat: Beat) {
    console.log('BeatRecorder: setBeat', beat.id);
    this.beat = beat;
    this.referenceTime = 0;
  }

  private handleStateChange = (state: any) => {
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
    this.referenceTime = tempoService.time;
    this.currentNoteIndex = 0;
  };

  public stop = () => {
    console.log('BeatRecorder: stop');
  };

  private findUnplayedNotes(currentBeatNote: BeatNote, playedNotes: string[]): string[] {
    // Parse the noteString to get expected notes
    const expectedNotes = currentBeatNote.noteString
      .replace(/[\[\]]/g, '') // Remove brackets
      .split(',')
      .map((note) => note.trim());

    // Find notes that weren't played
    return expectedNotes.filter(
      (expectedNote) => !playedNotes.some((playedNote) => Beat.isDrumEquivalent(expectedNote, String(playedNote)))
    );
  }

  // Once we have passed a note, check if any notes were missed. if so, emit a missedNotes event
  private checkUnplayedNotes = () => {
    console.log('BeatRecorder: checkUnplayedNotes', this.currentNoteIndex);
    const currentBeatNote: BeatNote = this.beat!.beatNotes[this.currentNoteIndex];
    const unplayedNotes = this.findUnplayedNotes(currentBeatNote, this.playedNotesForCurrentIndex.map(String));
    if (unplayedNotes.length > 0) {
      console.log('Missed notes:', unplayedNotes);
      const beatNoteFeedback = new BeatNoteFeedback({
        beat: this.beat,
        index: this.currentNoteIndex,
        beatNote: currentBeatNote,
        missedNotes: unplayedNotes,
      });
      this.performanceFeedback.beatNoteFeedback.push(beatNoteFeedback);
      this.emit('missedNotes', beatNoteFeedback);
    }
  };

  private midiService_midiNote = (e: any) => {
    if (!tempoService.isRecording || !this.beat) {
      return;
    }

    if (e.note === 75) {
      // Ignore metronome
      return;
    }

    const bpm = tempoService.bpm;
    const elapsedMsec = tempoService.elapsedMsec;
    const position = elapsedMsec % this.beat!.getLoopLengthMsec(bpm);
    // TODO: remove this.referenceTime
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

    const noteString = String(e.note);

    const playedNote = new BeatNote({
      id: uuidv4(),
      index: this.currentNoteIndex,
      noteString,
      barNum,
      beatNum,
      divisionNum,
      subDivisionNum: bestSubDivNum,
      numSubDivisions: bestSubDiv,
      velocity: e.velocity,
      microtiming: divisionElapsed - bestSubDivNum * (quarterNoteMsec / 2 / bestSubDiv),
    });

    var beatNoteFeedback;
    this.performance.notes.push(playedNote);
    if (this.beat) {
      beatNoteFeedback = this.performanceFeedback.addBeatNote(this.beat, noteString, e.velocity);
      if (beatNoteFeedback) {
        const tempoFeedback = this.performanceFeedback.getTempoFeedback(tempoService.bpm);
        this.emit('tempoFeedback', tempoFeedback);
      } else {
        console.log('BeatRecorder: handleMidiNote - no match', playedNote);
      }
    }

    this.emit('beatNote', beatNoteFeedback);
    const currentBeatNote = this.beat!.beatNotes[this.currentNoteIndex];

    this.playedNotesForCurrentIndex.push(e.note?.number);
    const unplayedNotes = this.findUnplayedNotes(currentBeatNote, this.playedNotesForCurrentIndex.map(String));
    if (unplayedNotes.length === 0) {
      // // If enough time has passed, go to next note
      // const currentBeatNoteTime = currentBeatNote.getTimeMsec(bpm);
      // // TODO: remove this.referenceTime and quantized
      // const isLastNote = this.currentNoteIndex === this.beat.beatNotes.length - 1;
      // const nextNoteIndex = (this.currentNoteIndex + 1) % this.beat.beatNotes.length;
      // const nextBeatNote = this.beat.beatNotes[nextNoteIndex];
      // const nextBeatNoteTime = nextBeatNote.getTimeMsec(tempoService.bpm);
      // const shouldAdvance = isLastNote
      //   ? position < 100 // If we're at the last note, advance when we're near the start of the loop
      //   : position >= nextBeatNoteTime; // Otherwise, advance when we pass the next note's time

      // if (shouldAdvance) {
      // Find any unplayed notes
      // this.checkUnplayedNotes();

      // Go to next note
      this.currentNoteIndex = (this.currentNoteIndex + 1) % this.beat!.beatNotes.length;
      this.playedNotesForCurrentIndex = [];
    }
  };

  public getPerformance(): Performance | null {
    return this.performance;
  }
}

export const beatRecorder = BeatRecorder.getInstance();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    beatRecorder.destroy();
  });
}
