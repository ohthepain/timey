import { createFileRoute } from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { AuthScreen } from '~/components/auth/AuthScreen';
import { HeaderSignInButton } from '~/components/auth/LoginButton';
import { UserMenu } from '~/components/auth/UserMenu';
import { useSession } from '~/server/auth-runtime/client';
import { authDestination } from '~/utils/authDestination';

const factoryOrigin = z
  .url({ protocol: /^http$/, hostname: /^127\.0\.0\.1$/ })
  .refine((value) => URL.parse(value)?.origin === value)
  .optional()
  .catch(undefined);

const accountFrameHeaders = createMiddleware().server(({ request, next }) => {
  const url = new URL(request.url);
  if (url.pathname === '/auth/factory-account') {
    const parent = factoryOrigin.parse(url.searchParams.get('factoryOrigin'));
    setResponseHeader('Cache-Control', 'no-store');
    setResponseHeader('Content-Security-Policy', `frame-ancestors ${parent || "'none'"}`);
  }
  return next();
});

export const Route = createFileRoute('/auth/$screen')({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: authDestination(search.returnTo),
    token: typeof search.token === 'string' ? search.token : '',
    error: typeof search.error === 'string' ? search.error : '',
    factoryOrigin: factoryOrigin.parse(search.factoryOrigin),
  }),
  server: { middleware: [accountFrameHeaders] },
  component: AuthenticationRoute,
});

function AuthenticationRoute() {
  const { screen } = Route.useParams();
  const search = Route.useSearch();
  if (screen === 'factory-account' && search.factoryOrigin) {
    return <FactoryAccount factoryOrigin={search.factoryOrigin} />;
  }
  return <AuthScreen key={screen} screen={screen} {...search} />;
}

function FactoryAccount({ factoryOrigin }: { factoryOrigin: string }) {
  const content = useRef<HTMLElement>(null);
  const { refetch } = useSession();
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void refetch();
    };
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refetch]);

  useEffect(() => {
    const element = content.current;
    if (!element || window.parent === window) return;
    const observer = new ResizeObserver(() => {
      window.parent.postMessage({ type: 'timey-account-height', height: element.offsetHeight }, factoryOrigin);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [factoryOrigin]);

  return (
    <main ref={content} className="flex max-h-72 flex-col items-end overflow-auto p-1">
      <HeaderSignInButton returnTo="/auth/session" linkProps={{ target: '_blank', rel: 'noopener noreferrer' }} />
      <UserMenu embedded />
    </main>
  );
}
