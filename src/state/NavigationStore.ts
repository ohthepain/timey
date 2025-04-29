import { create } from 'zustand';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';

interface NavigationState {
  currentBeat: Beat | null;
  performancesByBeatId: Record<string, Performance[]>;
  setCurrentBeat: (beat: Beat | null) => void;
  cachePerformance: (performance: Performance) => void;
  clearPerformancesForBeatId: (beatId: string) => void;
  getPerformancesForBeatId: (beatId: string) => Performance[];
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentBeat: null,
  performancesByBeatId: {},
  setCurrentBeat: (beat) => set(() => ({ currentBeat: beat })),
  clearPerformancesForBeatId: (beatId) =>
    set((state) => ({
      performancesByBeatId: {
        ...state.performancesByBeatId,
        [beatId]: [],
      },
    })),
  cachePerformance: (performance) =>
    set((state) => ({
      performancesByBeatId: {
        ...state.performancesByBeatId,
        [performance.beatId]: [...(state.performancesByBeatId[performance.beatId] || []), performance],
      },
    })),
  getPerformancesForBeatId: (beatId): Performance[] => {
    const performances = useNavigationStore.getState().performancesByBeatId[beatId];
    return performances || [];
  },
}));
