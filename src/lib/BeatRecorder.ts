import { EventEmitter } from 'events';
import { midiService } from '~/lib/MidiService';
import { v4 as uuidv4 } from 'uuid';
import { tempoService } from '~/lib/MidiSync/TempoService';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { Performance } from '~/types/Performance';
import { savePerformanceServerFn, deletePerformancesByBeatIdAndUserId } from '~/services/performanceService.server';
import { useNavigationStore } from '~/state/NavigationStore';
import { PerformanceFeedback } from './PerformanceFeedback';

// Helper to quantize a time to the nearest 32nd note
function quantizeTo32nd(timeMsec: number, bpm: number, referenceTime: number) {
  // 1 quarter note = 60,000 / bpm ms
  // 1 32nd note = quarterNoteMsec / 8
  const quarterNoteMsec = 60000 / bpm;
  const thirtySecondMsec = quarterNoteMsec / 8;
  const elapsed = timeMsec - referenceTime;
  const quantized = Math.round(elapsed / thirtySecondMsec) * thirtySecondMsec;
  return { quantized, elapsed, thirtySecondMsec };
}

class BeatRecorder extends EventEmitter {
  private static _instance: BeatRecorder;
  public performance: Performance = new Performance({ beatId: 'no beat!' });
  public performanceFeedback: PerformanceFeedback = new PerformanceFeedback([]);
  private referenceTime: number = 0;
  private lastIndex: number = 0;
  private lastQuantizedTime: number = -Infinity;
  private quantizeThreshold: number = 10; // ms threshold for simultaneity
  private beat: Beat | null = null;

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
    this.lastIndex = 0;
    this.lastQuantizedTime = -Infinity;
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
    this.lastIndex = 0;
    this.lastQuantizedTime = -Infinity;
  };

  public stop = () => {
    console.log('BeatRecorder: stop');
  };

  private midiService_midiNote = (e: any) => {
    if (!tempoService.isRecording) {
      return;
    }

    if (e.note?.number === 75) {
      // Ignore metronome
      return;
    }

    const bpm = tempoService.bpm;
    const elapsedMsec = tempoService.elapsedMsec;
    const { quantized, elapsed, thirtySecondMsec } = quantizeTo32nd(elapsedMsec, bpm, this.referenceTime);
    // Calculate position in the bar
    const quarterNoteMsec = 60000 / bpm;
    const barLengthMsec = quarterNoteMsec * 4;
    const barNum = Math.floor(elapsed / barLengthMsec);
    const barElapsed = elapsed - barNum * barLengthMsec;
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
    // Simultaneous/flammed notes: if quantized time is close to last, use same index
    let noteIndex = this.lastIndex;
    if (Math.abs(quantized - this.lastQuantizedTime) > this.quantizeThreshold) {
      noteIndex = ++this.lastIndex;
      this.lastQuantizedTime = quantized;
    }
    const noteString = String(e.note?.number || e.note || 'unknown');
    const beatNote = new BeatNote({
      id: uuidv4(),
      index: noteIndex,
      noteString,
      barNum,
      beatNum,
      divisionNum,
      subDivisionNum: bestSubDivNum,
      numSubDivisions: bestSubDiv,
      velocity: e.velocity || 100,
      microtiming: divisionElapsed - bestSubDivNum * (quarterNoteMsec / 2 / bestSubDiv),
    });

    var beatNoteFeedback;
    this.performance.notes.push(beatNote);
    if (this.beat) {
      beatNoteFeedback = this.performanceFeedback.addBeatNote(this.beat, noteString, e.velocity || 100);
      if (beatNoteFeedback) {
        const tempoFeedback = this.performanceFeedback.getTempoFeedback(tempoService.bpm);
        this.emit('tempoFeedback', tempoFeedback);
      } else {
        console.log('BeatRecorder: handleMidiNote - no match', beatNote);
      }
    }

    this.emit('beatNote', beatNote, beatNoteFeedback);
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
