import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { authClient } from '~/server/auth-runtime/client';
import { useNavigationStore } from '~/state/NavigationStore';
import { practiceIdentity, setPracticeUser } from '~/state/privatePractice';

export function PracticeSession() {
  const returnTo = useRouterState({ select: (state) => state.location.pathname });
  const isAuthScreen = returnTo.startsWith('/auth/');
  const { data: session, error } = authClient.useSession();
  useEffect(() => {
    let active = true;
    let latest = 0;
    setPracticeUser(null);
    if (isAuthScreen) return;
    const apply = (sequence: number, userId: string | null) => {
      if (active && sequence === latest) setPracticeUser(userId);
    };
    const refresh = async () => {
      const sequence = ++latest;
      try {
        apply(sequence, await practiceIdentity());
      } catch {
        apply(sequence, null);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [session?.user.id, session?.session.id, error, isAuthScreen]);
  const userId = useNavigationStore((state) => state.practiceUserId);
  return (
    <a
      className="text-indigo-600 underline text-sm"
      href={`/auth/${userId ? 'session' : 'login'}?returnTo=${encodeURIComponent(returnTo)}`}
    >
      {userId ? 'Practice account' : 'Sign in to save practice'}
    </a>
  );
}
