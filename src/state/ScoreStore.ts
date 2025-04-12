import { create } from 'zustand';
import { ParseBeatStrings } from '../lib/ParseBeat';
import { Beat, BeatNote } from '@prisma/client';

interface ScoreStoreState {
  beats: Record<string, string>;
  addBeat: (key: string, beatStrings: string[][]) => void;
  getBeat: (key: string) => string | undefined;
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
