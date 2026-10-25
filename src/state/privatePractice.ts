import { useNavigationStore } from './NavigationStore';

// Browser cache ownership only. Server authorization always revalidates the cookie.
export function setPracticeUser(userId: string | null) {
  const state = useNavigationStore.getState();
  if (state.practiceUserId !== userId) {
    useNavigationStore.setState({
      practiceUserId: userId,
      practiceGeneration: state.practiceGeneration + 1,
      performancesByBeatId: {},
      currentPerformance: null,
    });
  }
}

export async function practiceIdentity(): Promise<string | null> {
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Practice profile unavailable. Retry the request.');
  return (await response.json()).userId;
}

function acceptIdentity(owner: string, generation: number, identity: string | null) {
  const current = useNavigationStore.getState();
  if (current.practiceGeneration !== generation) return false;
  if (identity !== owner) {
    setPracticeUser(identity);
    return false;
  }
  return true;
}

async function checkedPractice<T>(owner: string, generation: number, operation: () => Promise<T>) {
  if (!acceptIdentity(owner, generation, await practiceIdentity())) return;
  const result = await operation();
  if (!acceptIdentity(owner, generation, await practiceIdentity())) return;
  return result;
}

function expireGeneration(generation: number) {
  if (useNavigationStore.getState().practiceGeneration === generation) setPracticeUser(null);
}

export async function privatePractice<T>(operation: () => Promise<T>): Promise<T | undefined> {
  const { practiceUserId, practiceGeneration } = useNavigationStore.getState();
  if (!practiceUserId) throw new Error('Sign in to save practice.');
  try {
    return await checkedPractice(practiceUserId, practiceGeneration, operation);
  } catch (error) {
    expireGeneration(practiceGeneration);
    throw error;
  }
}
