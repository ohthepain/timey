import { create } from 'zustand';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';

interface NavigationState {
  currentBeat: Beat | null;
  currentPerformance: Performance | null;
  performancesByBeatId: Record<string, Performance[]>;
  isMetronomeOn: boolean;
  setCurrentBeat: (beat: Beat | null) => void;
  setCurrentPerformance: (performance: Performance | null) => void;
  cachePerformance: (performance: Performance) => void;
  clearPerformancesForBeatId: (beatId: string) => void;
  getPerformancesForBeatId: (beatId: string) => Performance[];
  setMetronomeOn: (on: boolean) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentBeat: null,
  currentPerformance: null,
  performancesByBeatId: {},
  isMetronomeOn: true,
  setCurrentBeat: (beat) => set(() => ({ currentBeat: beat })),
  setCurrentPerformance: (performance: Performance | null) => set(() => ({ currentPerformance: performance })),
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
  setMetronomeOn: (on: boolean) => set(() => ({ isMetronomeOn: on })),
}));
