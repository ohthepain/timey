import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { beatRecorder } from './BeatRecorder';
import { TempoService } from './MidiSync/TempoService';
import { midiService } from './MidiService';
import { moduleRepository } from '~/repositories/moduleRepository';
import { Performance } from '~/types/Performance';
import { PerformanceFeedback } from './PerformanceFeedback';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';
import { GeneralMidiService } from './GeneralMidiService';
import { BeatNoteFeedback } from './PerformanceFeedback';
import { EventRecorderService } from './EventRecorderService';

// Helper function to dump performance and feedback data
function dump(performance: Performance, feedback: BeatNoteFeedback[]) {
  console.log('\nPerformance Notes:');
  performance.notes.forEach((note, i) => {
    console.log(`  ${i + 1}. ${note.noteString} - timing: ${note.microtiming}ms, velocity: ${note.velocity}`);
  });

  console.log('\nFeedback:');
  feedback.forEach((f, i) => {
    console.log(`  ${i + 1}. Beat ${f.index}:`);
    if (f.missedNotes?.length) {
      console.log(`     Missed: ${f.missedNotes.join(', ')}`);
    }
    if (f.performanceNote) {
      console.log(
        `     Played: ${f.performanceNote.noteString} - timing: ${f.timingDifferenceMs}ms, velocity diff: ${f.velocityDifference}`
      );
    }
  });
  console.log('\n');
}

describe('BeatRecorder', () => {
  let beat: Beat;
  let eventRecorder: EventRecorderService;
  let tempoService: TempoService;

  beforeAll(async () => {
    eventRecorder = EventRecorderService.getInstance();
    tempoService = TempoService.getInstance();

    // Fetch the real module
    const module = await moduleRepository.getModuleById('c55b83e4-11d9-48f3-acc9-bbcbfb8a1a1f');
    if (!module || !module.beats || module.beats.length === 0) {
      throw new Error('Module not found or has no beats');
    }

    beat = new Beat(module.beats[0]); // Properly instantiate the Beat class
  });

  beforeEach(async () => {
    // Start the tempo service with simulated timer
    tempoService.reset();
    tempoService.startSimulatedIntervalTimerForTesting();
    tempoService.bpm = 120; // Set a standard BPM for testing

    // Reset the beat recorder
    beatRecorder.performance = new Performance({ beatId: beat.id });
    beatRecorder.performanceFeedback = new PerformanceFeedback([]);

    // Reset the recorder state
    beatRecorder.setBeat(beat);
    tempoService.isRecording = true;
  });

  afterEach(() => {
    // Clean up
    tempoService.stop();
  });

  function eighthNoteMsec() {
    return 60000 / tempoService.bpm / 2;
  }

  function sixteenthNoteMsec() {
    return 60000 / tempoService.bpm / 4;
  }

  // Helper function to simulate a bar of time
  function simulateEighth() {
    tempoService.simulateInterval(eighthNoteMsec());
  }

  function simulateSixteenth() {
    tempoService.simulateInterval(sixteenthNoteMsec());
  }

  // Use GeneralMidiService instead of local map
  function getNote(drumName: string): number {
    const note = GeneralMidiService.getNoteNumber(drumName);
    if (!note) throw new Error(`Unknown drum name: ${drumName}`);
    return note;
  }

  it('play the beat perfectly!', () => {
    // Play through all notes in the beat
    let numNotes = 0;
    for (const beatNote of beat.beatNotes) {
      // Parse the noteString to get the expected notes
      const expectedNotes = beatNote.noteString
        .replace(/[\[\]]/g, '')
        .split(',')
        .map((note: string) => note.trim());

      // Play each expected note
      for (const note of expectedNotes) {
        const midiNote = getNote(note);
        midiService.emitMidiNote(midiNote, 100);
        numNotes++;
        // debugger; // This will force a breakpoint
      }
      simulateEighth();
    }

    // Check the results
    console.log('Final state:', {
      performanceNotes: beatRecorder.performance.notes,
      feedback: beatRecorder.performanceFeedback.beatNoteFeedback,
      numNotes,
    });
    expect(beatRecorder.performance.notes).toHaveLength(numNotes);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(numNotes);

    // Verify each note was recorded correctly
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
      // Add more specific assertions based on the expected note structure
    });
  });

  it('first note', () => {
    midiService.emitMidiNote(getNote('kick'), 100);

    expect(beatRecorder.performance.notes).toHaveLength(1);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(1);

    // Verify each note was recorded correctly
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
      // Add more specific assertions based on the expected note structure
    });
  });

  it('missing first note', () => {
    // midiService.emitMidiNote(getNote('kick'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);
    simulateEighth();

    expect(beatRecorder.performance.notes).toHaveLength(1);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(2);

    // Verify each note was recorded correctly
    let numMissedNotes = 0;
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
    });

    beatRecorder.performanceFeedback.beatNoteFeedback.forEach((feedback) => {
      const f = feedback;
      if (feedback.missedNotes?.length) {
        numMissedNotes += feedback.missedNotes.length;
        expect(feedback.beat).toBe(beat);
        expect(feedback.index).toBe(0);
        expect(feedback.beatNote!.barNum).toBe(0);
        expect(feedback.beatNote!.noteString).toBe('kick, hihat');
        expect(feedback.performanceNote).toBe(undefined);
        expect(feedback.timingDifferenceMs).toBe(undefined);
        expect(feedback.velocityDifference).toBe(undefined);
        expect(feedback.missedNotes).toEqual(['kick']);
      }
    });

    expect(numMissedNotes).toBe(1);
  });

  it('miss first note 2, with extra note', () => {
    // midiService.emitMidiNote(getNote('kick'), 100);
    tempoService.simulateInterval(10);
    midiService.emitMidiNote(getNote('hihat'), 100);
    midiService.emitMidiNote(getNote('snare'), 100);
    simulateEighth();
    midiService.emitMidiNote(getNote('hihat'), 100);

    // dump(beatRecorder.performance, beatRecorder.performanceFeedback.beatNoteFeedback);
    eventRecorder.saveToCsv('test.csv');

    const a = beatRecorder;
    expect(beatRecorder.performance.notes).toHaveLength(3);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(3);

    // Verify each note was recorded correctly
    let numMissedNotes = 0;
    let notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
    });

    beatRecorder.performanceFeedback.beatNoteFeedback.forEach((feedback) => {
      const f = feedback;
      if (feedback.missedNotes?.length) {
        numMissedNotes += feedback.missedNotes.length;
        expect(feedback.index).toBe(0);
        expect(feedback.missedNotes).toEqual(['kick']);
      }
    });

    expect(numMissedNotes).toBe(1);

    // Reset state, including performance and performanceFeedback
    eventRecorder.saveToCsv('test.csv');
    eventRecorder.replay();
    eventRecorder.saveToCsv('test.csv');

    expect(beatRecorder.performance.notes).toHaveLength(3);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(3);

    // Verify each note was recorded correctly
    numMissedNotes = 0;
    notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
    });

    beatRecorder.performanceFeedback.beatNoteFeedback.forEach((feedback) => {
      const f = feedback;
      if (feedback.missedNotes?.length) {
        numMissedNotes += feedback.missedNotes.length;
        expect(feedback.index).toBe(0);
        expect(feedback.missedNotes).toEqual(['kick']);
      }
    });

    expect(numMissedNotes).toBe(1);
  });

  it('auto-advance on extra note', () => {
    midiService.emitMidiNote(getNote('kick'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);

    expect(beatRecorder.performance.notes).toHaveLength(3);
    const f = beatRecorder.performanceFeedback.beatNoteFeedback;
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(3);

    // Verify each note was recorded correctly
    let numMissedNotes = 0;
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect([0, -sixteenthNoteMsec()]).toContain(note.microtiming);
    });

    beatRecorder.performanceFeedback.beatNoteFeedback.forEach((feedback) => {
      const f = feedback;
      if (feedback.missedNotes?.length) {
        numMissedNotes += feedback.missedNotes.length;
        expect(feedback.beat).toBe(beat);
        expect(feedback.index).toBe(0);
        expect(feedback.beatNote!.barNum).toBe(0);
        expect(feedback.beatNote!.noteString).toBe('kick, hihat');
        expect(feedback.performanceNote).toBe(undefined);
        expect(feedback.timingDifferenceMs).toBe(undefined);
        expect(feedback.velocityDifference).toBe(undefined);
        expect(feedback.missedNotes).toEqual(['kick']);
      }
    });

    expect(numMissedNotes).toBe(0);
  });

  it('auto-advance only works during interval of current index', () => {
    midiService.emitMidiNote(getNote('kick'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);
    midiService.emitMidiNote(getNote('hihat'), 100);

    expect(beatRecorder.performance.notes).toHaveLength(4);
    const f = beatRecorder.performanceFeedback.beatNoteFeedback;
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(3);

    // Verify each note was recorded correctly
    let numMissedNotes = 0;
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect([0, -sixteenthNoteMsec()]).toContain(note.microtiming);
    });

    beatRecorder.performanceFeedback.beatNoteFeedback.forEach((feedback) => {
      const f = feedback;
      if (feedback.missedNotes?.length) {
        numMissedNotes += feedback.missedNotes.length;
        expect(feedback.beat).toBe(beat);
        expect(feedback.index).toBe(0);
        expect(feedback.beatNote!.barNum).toBe(0);
        expect(feedback.beatNote!.noteString).toBe('kick, hihat');
        expect(feedback.performanceNote).toBe(undefined);
        expect(feedback.timingDifferenceMs).toBe(undefined);
        expect(feedback.velocityDifference).toBe(undefined);
        expect(feedback.missedNotes).toEqual(['kick']);
      }
    });

    expect(numMissedNotes).toBe(0);
  });

  // it('wip: test miss first note', () => {
  //   beatRecorder.setBeat(beat);
  //   tempoService.isRecording = true;

  //   // midiService.emitMidiNote(getNote('kick'), 100);
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('kick'), 100);
  //   midiService.emitMidiNote(getNote('snare'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('kick'), 100);
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('kick'), 100);
  //   midiService.emitMidiNote(getNote('snare'), 100);
  //   simulateEighth();
  //   midiService.emitMidiNote(getNote('hihat'), 100);
  //   simulateEighth();

  //   // Check the results
  //   expect(beatRecorder.performance.notes).toHaveLength(12);
  //   expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(12);
  //   expect(beatRecorder.performanceFeedback.beatNoteFeedback[0].missedNotes?.length).toBe(1);

  //   // Verify each note was recorded correctly
  //   const notes = beatRecorder.performance.notes;
  //   notes.forEach((note: BeatNote) => {
  //     expect(note.microtiming).toBe(0);
  //     // Add more specific assertions based on the expected note structure
  //   });

  //   it('manual play of beat', () => {
  //     beatRecorder.setBeat(beat);
  //     tempoService.isRecording = true;

  //     midiService.emitMidiNote(getNote('kick'), 100);
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('kick'), 100);
  //     midiService.emitMidiNote(getNote('snare'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('kick'), 100);
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('kick'), 100);
  //     midiService.emitMidiNote(getNote('snare'), 100);
  //     simulateEighth();
  //     midiService.emitMidiNote(getNote('hihat'), 100);
  //     simulateEighth();

  //     // Check the results
  //     expect(beatRecorder.performance.notes).toHaveLength(12);
  //     expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(12);

  //     // Verify each note was recorded correctly
  //     const notes = beatRecorder.performance.notes;
  //     notes.forEach((note: BeatNote) => {
  //       expect(note.microtiming).toBe(0);
  //       // Add more specific assertions based on the expected note structure
  //     });
  //   });
  // });
});
