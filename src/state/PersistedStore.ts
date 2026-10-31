import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PersistedState {
  enableAdmin: boolean;
  devMode: boolean;
  midiSlave: boolean;
  setAdmin: (on: boolean) => void;
  setDevMode: (on: boolean) => void;
  setMidiSlave: (midiSlave: boolean) => void;
}

export const usePersistedStore = create<PersistedState>()(
  persist(
    (set) => ({
      enableAdmin: false,
      devMode: false,
      midiSlave: false,
      setAdmin: (on: boolean) => set({ enableAdmin: on }),
      setDevMode: (on: boolean) => set({ devMode: on }),
      setMidiSlave: (midiSlave: boolean) => set({ midiSlave: midiSlave }),
    }),
    {
      name: 'persisted-storage',
    }
  )
);
