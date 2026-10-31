import { afterEach, expect, it, vi } from 'vite-plus/test';
import { privatePractice, setPracticeUser } from './privatePractice';
import { useNavigationStore } from './NavigationStore';
import { Performance } from '~/types/Performance';

let identity: string | null = 'owner-a';
afterEach(() => {
  setPracticeUser(null);
  vi.unstubAllGlobals();
  identity = 'owner-a';
});

function setup() {
  setPracticeUser('owner-a');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ userId: identity }), { status: identity ? 200 : 401 }))
  );
}

it('discards a late response after switching away and back to the same owner', async () => {
  setup();
  let finish!: (value: string) => void;
  const pending = privatePractice(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  setPracticeUser('owner-b');
  setPracticeUser('owner-a');
  finish('old private response');
  expect(await pending).toBeUndefined();
});

it('clears cached recordings and selected private data when the session is lost', async () => {
  setup();
  const recording = new Performance({ beatId: 'beat', userId: 'owner-a' });
  useNavigationStore.getState().cachePerformance(recording);
  useNavigationStore.getState().setCurrentPerformance(recording);
  identity = null;
  const mutation = vi.fn();
  expect(await privatePractice(mutation)).toBeUndefined();
  expect(mutation).not.toHaveBeenCalled();
  expect(useNavigationStore.getState().performancesByBeatId).toEqual({});
  expect(useNavigationStore.getState().currentPerformance).toBeNull();
});

it('discards a result when the cookie identity changes during the operation', async () => {
  setup();
  expect(
    await privatePractice(async () => {
      identity = 'owner-b';
      return 'private result';
    })
  ).toBeUndefined();
  expect(useNavigationStore.getState().practiceUserId).toBe('owner-b');
});
