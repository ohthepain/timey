import React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { PracticeSession } from './PracticeSession';
import { useSession } from '~/server/auth-runtime/client';

interface LoginButtonProps {
  children?: React.ReactNode;
}

export function LoginButton(props: LoginButtonProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <>
      <PracticeSession />
      <HeaderSignInButton {...props} returnTo={pathname} />
    </>
  );
}

export function HeaderSignInButton({
  children = 'Login',
  returnTo,
  linkProps,
}: LoginButtonProps & { returnTo: string; linkProps?: Pick<React.ComponentProps<'a'>, 'target' | 'rel'> }) {
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

  const href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <a
      href={href}
      {...linkProps}
      className="px-2 py-1 bg-orange-200 hover:bg-orange-300 text-orange-800 border-2 border-orange-600 rounded-md transition-colors duration-200 text-sm"
    >
      {children}
    </a>
  );
}
