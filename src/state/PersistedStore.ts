import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PersistedState {
  enableAdmin: boolean;
  devMode: boolean;
  setAdmin: (on: boolean) => void;
  setDevMode: (on: boolean) => void;
}

export const usePersistedStore = create<PersistedState>()(
  persist(
    (set) => ({
      enableAdmin: false,
      devMode: false,
      setAdmin: (on: boolean) => set({ enableAdmin: on }),
      setDevMode: (on: boolean) => set({ devMode: on }),
    }),
    {
      name: 'persisted-storage',
    }
  )
);
