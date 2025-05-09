import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { beatRecorder } from './BeatRecorder';
import { tempoService } from './MidiSync/TempoService';
import { midiService } from './MidiService';
import { moduleRepository } from '~/repositories/moduleRepository';
import { Performance } from '~/types/Performance';
import { PerformanceFeedback } from './PerformanceFeedback';
import { Beat } from '~/types/Beat';
import { BeatNote } from '~/types/BeatNote';

describe('BeatRecorder', () => {
  let beat: Beat;

  beforeEach(async () => {
    // Fetch the real module
    const module = await moduleRepository.getModuleById('c55b83e4-11d9-48f3-acc9-bbcbfb8a1a1f');
    if (!module || !module.beats || module.beats.length === 0) {
      throw new Error('Module not found or has no beats');
    }

    beat = new Beat(module.beats[0]); // Properly instantiate the Beat class

    // Reset the beat recorder
    beatRecorder.performance = new Performance({ beatId: beat.id });
    beatRecorder.performanceFeedback = new PerformanceFeedback([]);

    // Reset the recorder state
    beatRecorder.setBeat(beat);

    // Start the tempo service with simulated timer
    tempoService.startSimulatedIntervalTimerForTesting();
    tempoService.bpm = 120; // Set a standard BPM for testing
  });

  afterEach(() => {
    // Clean up
    tempoService.stop();
  });

  // Helper function to simulate a bar of time
  function simulateEighth() {
    const quarterNoteMsec = 60000 / tempoService.bpm;
    tempoService.simulateInterval(quarterNoteMsec / 2);
  }

  // MIDI note mapping
  const midiNoteMap: Record<string, number> = {
    kick: 36,
    snare: 38,
    hihat: 42,
    tom: 45,
    ride: 51,
    crash: 49,
  };

  it('play the beat perfectly!', () => {
    beatRecorder.setBeat(beat);
    tempoService.isRecording = true;

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
        const midiNote = midiNoteMap[note] || 36; // Default to kick if note not found
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

  it('test manual play of beat', () => {
    beatRecorder.setBeat(beat);
    tempoService.isRecording = true;

    midiService.emitMidiNote(midiNoteMap.kick, 100);
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.kick, 100);
    midiService.emitMidiNote(midiNoteMap.snare, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.kick, 100);
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.kick, 100);
    midiService.emitMidiNote(midiNoteMap.snare, 100);
    simulateEighth();
    midiService.emitMidiNote(midiNoteMap.hihat, 100);
    simulateEighth();

    // Check the results
    expect(beatRecorder.performance.notes).toHaveLength(12);
    expect(beatRecorder.performanceFeedback.beatNoteFeedback).toHaveLength(12);

    // Verify each note was recorded correctly
    const notes = beatRecorder.performance.notes;
    notes.forEach((note: BeatNote) => {
      expect(note.microtiming).toBe(0);
      // Add more specific assertions based on the expected note structure
    });
  });
});
