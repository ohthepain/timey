import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import * as React from 'react';
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary';
import { NotFound } from '~/components/NotFound';
import appCss from '~/styles/app.css?url';
import { seo } from '~/utils/seo';
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignInButton,
  SignOutButton,
  // UserButton,
} from '@clerk/tanstack-react-start';
import { UserButton } from '@clerk/clerk-react';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      ...seo({
        title: 'TanStack Start | Type-Safe, Client-First, Full-Stack React Framework',
        description: `TanStack Start is a type-safe, client-first, full-stack React framework. `,
      }),
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png',
      },
      { rel: 'manifest', href: '/site.webmanifest', color: '#fffff' },
      { rel: 'icon', href: '/favicon.ico' },
    ],
  }),
  errorComponent: (props) => {
    return (
      <RootDocument>
        <DefaultCatchBoundary {...props} />
      </RootDocument>
    );
  },
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html>
        <head>
          <HeadContent />
        </head>
        <body>
          <div className="p-2 flex justify-between items-center text-lg">
            {/* Left-aligned navigation links */}
            <div className="flex gap-2 bg-green-300">
              <Link
                to="/"
                activeProps={{
                  className: 'font-bold',
                }}
                activeOptions={{ exact: true }}
              >
                Home
              </Link>
              <Link
                to="/posts"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Posts
              </Link>
              <Link
                to="/methods"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Methods
              </Link>
              <Link
                to="/sequence"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Sequence
              </Link>
              <Link
                to="/users"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Users
              </Link>
              <Link
                to="/route-a"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Pathless Layout
              </Link>
              <Link
                to="/deferred"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                Deferred
              </Link>
              <Link
                // @ts-expect-error
                to="/this-route-does-not-exist"
                activeProps={{
                  className: 'font-bold',
                }}
              >
                This Route Does Not Exist
              </Link>
            </div>

            {/* Right-aligned buttons */}
            <div className="flex gap-2">
              <SignedOut>
                <SignInButton />
              </SignedOut>
              <SignedIn>
                <SignOutButton />
                <UserButton />
              </SignedIn>
            </div>
          </div>
          <hr />
          {children}
          <TanStackRouterDevtools position="bottom-right" />
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}
