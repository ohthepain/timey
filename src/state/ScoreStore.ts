import { create } from 'zustand';
import { ParseBeatStrings } from '../lib/ParseBeat';

interface ScoreStoreState {
  beats: Record<string, string>; // Stores beat strings indexed by a key
  addBeat: (key: string, beatStrings: string[][]) => void; // Adds a new beat
  getBeat: (key: string) => string | undefined; // Retrieves a beat by key
}

export const useScoreStore = create<ScoreStoreState>((set, get) => ({
  beats: {},

  // Add a new beat to the store
  addBeat: (key: string, beatStrings: string[][]) => {
    const beatString = ParseBeatStrings(beatStrings); // Parse the beat strings
    set((state) => ({
      beats: {
        ...state.beats,
        [key]: beatString, // Add or update the beat string for the given key
      },
    }));
  },

  // Retrieve a beat by its key
  getBeat: (key: string) => {
    return get().beats[key];
  },
}));
