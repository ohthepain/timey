// Mock MidiService to prevent Web MIDI initialization
global.vi.mock('./MidiService', () => {
  class MockMidiService extends EventEmitter {
    emitMidiNote(note: number, velocity: number) {
      this.emit('midiNote', { note, velocity: velocity || 100 });
    }
  }
  return {
    midiService: new MockMidiService(),
  };
});

// Mock Web MIDI API
Object.defineProperty(global.navigator, 'requestMIDIAccess', {
  value: vi.fn().mockImplementation(() =>
    Promise.resolve({
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  ),
});

import '@testing-library/jest-dom';
import { EventEmitter } from 'events';
import { ParseBeatSource, ParseBeatString } from '~/lib/ParseBeat';
import { BeatSource } from '~/types/BarSource';
import { Beat } from '~/types/Beat';
declare global {
  var vi: {
    mock: (path: string, factory: () => any) => void;
    fn: () => {
      mockImplementation: (impl: Function) => any;
    };
  };
}

// Create a beat source with the same patterns as BeatEditor
const makeTestBeat = (moduleId: string): Beat => {
  const beatSource = new BeatSource([
    {
      kick: 'k,,,,k,,,',
      hihat: 'h,h,h,h,h,h,h,h',
      snare: ',,s,,,,s,',
      accent: 'a,,a,,a,,a,',
    },
  ]);

  const beatString = ParseBeatSource(beatSource);
  const { beatNotes } = ParseBeatString(beatString);
  const testBeat = new Beat({
    id: 'testBeat',
    name: 'testBeat',
    index: 0,
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: beatNotes,
    description: '',
    moduleId: moduleId,
  });
  return testBeat;
};

// Mock the module repository for testing
global.vi.mock('~/repositories/moduleRepository', () => ({
  moduleRepository: {
    getModuleById: global.vi.fn().mockImplementation(async (id: string) => ({
      id,
      title: 'Test Module',
      beats: [makeTestBeat(id)],
    })),
  },
}));
