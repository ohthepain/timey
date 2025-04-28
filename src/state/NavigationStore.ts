import { create } from 'zustand';
import { Beat } from '~/types/Beat';

interface NavigationState {
  currentBeat: Beat | null;
  setCurrentBeat: (beat: Beat | null) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentBeat: null,
  setCurrentBeat: (beat) => set(() => ({ currentBeat: beat })),
}));
