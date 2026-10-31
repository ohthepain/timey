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
import { createTestBeat } from '~/lib/createTestBeat';
declare global {
  var vi: {
    mock: (path: string, factory: () => any) => void;
    fn: () => {
      mockImplementation: (impl: Function) => any;
    };
  };
}

// Mock the module repository for testing
global.vi.mock('~/repositories/moduleRepository', () => ({
  moduleRepository: {
    getModuleById: global.vi.fn().mockImplementation(async (id: string) => ({
      id,
      title: 'Test Module',
      beats: [createTestBeat(id)],
    })),
  },
}));
