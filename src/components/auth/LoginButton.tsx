import React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { PracticeSession } from './PracticeSession';
import { useSession } from '~/server/auth-runtime/client';

interface LoginButtonProps {
  children?: React.ReactNode;
}

export function LoginButton(props: LoginButtonProps) {
  return (
    <>
      <PracticeSession />
      <HeaderSignInButton {...props} />
    </>
  );
}

function HeaderSignInButton({ children = 'Login' }: LoginButtonProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <button
        className="text-orange-700 px-2 py-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
        disabled
      >
        Loading...
      </button>
    );
  }

  if (session?.user) {
    return null;
  }

  const href = `/auth/login?returnTo=${encodeURIComponent(pathname)}`;

  return (
    <a
      href={href}
      className="px-2 py-1 bg-orange-200 hover:bg-orange-300 text-orange-800 border-2 border-orange-600 rounded-md transition-colors duration-200 text-sm"
    >
      {children}
    </a>
  );
}
