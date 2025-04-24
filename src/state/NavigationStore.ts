import { create } from 'zustand';
import { Beat } from '~/types/Beat';

interface NavigationState {
  currentBeat: Beat | null;
  setBeat: (beat: Beat | null) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentBeat: null,
  setBeat: (beat) => set(() => ({ currentBeat: beat })),
}));
