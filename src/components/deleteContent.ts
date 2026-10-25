import { useNavigationStore } from '~/state/NavigationStore';

export async function confirmContentDeletion(kind: string, operation: () => Promise<unknown>) {
  const { practiceUserId, practiceGeneration } = useNavigationStore.getState();
  if (!practiceUserId) return false;
  if (
    !window.confirm(
      `Delete this ${kind} and all its descendants? This permanently removes their associated practice history for every user. This cannot be undone.`
    )
  )
    return false;
  const current = useNavigationStore.getState();
  if (identityChanged(current, practiceUserId, practiceGeneration)) return false;
  await operation();
  useNavigationStore.setState((state) => ({
    currentBeat: null,
    currentPerformance: null,
    performancesByBeatId: {},
    practiceGeneration: state.practiceGeneration + 1,
  }));
  return true;
}

function identityChanged(
  current: { practiceUserId: string | null; practiceGeneration: number },
  userId: string,
  generation: number
) {
  return current.practiceUserId !== userId || current.practiceGeneration !== generation;
}
