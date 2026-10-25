import { useEffect, useState } from 'react';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';
import { useNavigationStore } from '~/state/NavigationStore';
import { privatePractice } from '~/state/privatePractice';
import { getBeatWithPerformancesServerFn } from '~/services/beatService.server';
import { startBeatServerFn, passBeatTempoServerFn } from '~/services/userProgressServerService.server';
import { beatPlayer } from '~/lib/BeatPlayer';
import { BeatRecorder } from '~/lib/BeatRecorder';

export function useBeatPractice(beat: Beat) {
  const userId = useNavigationStore((state) => state.practiceUserId);
  const [practiceError, setPracticeError] = useState('');
  useEffect(() => {
    let active = true;
    setPracticeError('');
    if (userId && beat.id) {
      const beatId = beat.id;
      privatePractice(() => getBeatWithPerformancesServerFn({ data: { beatId } }))
        .then((saved) => {
          if (!active || !saved) return;
          const cache = useNavigationStore.getState();
          cache.clearPerformancesForBeatId(beatId);
          saved.performances.forEach((performance) => cache.cachePerformance(new Performance(performance)));
        })
        .catch(() => {
          if (active) setPracticeError('Saved practice unavailable. Sign in or retry.');
        });
    }
    return () => {
      active = false;
    };
  }, [beat.id, userId]);

  async function selectBeat() {
    beatPlayer.setBeat(beat);
    BeatRecorder.getInstance().setBeat(beat);
    if (!userId || !beat.id) return;
    try {
      await privatePractice(() => startBeatServerFn({ data: { beatId: beat.id! } }));
    } catch {
      setPracticeError('Practice is local. Sign in or retry to save progress.');
    }
  }

  async function passTempo(tempo: number) {
    if (!userId) {
      window.location.assign('/auth/login?returnTo=' + encodeURIComponent(window.location.pathname));
      return;
    }
    if (!beat.id) return;
    try {
      await privatePractice(() => passBeatTempoServerFn({ data: { beatId: beat.id!, tempo } }));
    } catch {
      setPracticeError('Unable to save tempo. Sign in or retry.');
    }
  }
  return { practiceError, selectBeat, passTempo };
}
