import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PersistedState {
  enableAdmin: boolean;
  setAdmin: (on: boolean) => void;
}

export const usePersistedStore = create<PersistedState>()(
  persist(
    (set) => ({
      enableAdmin: false,
      setAdmin: (on: boolean) => set({ enableAdmin: on }),
    }),
    {
      name: 'persisted-storage',
    }
  )
);
