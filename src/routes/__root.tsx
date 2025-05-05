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
import { useState } from 'react';
import MidiSelector from '~/components/DeviceSelector/MidiSelector';
import MetronomeMidiSettings from '~/components/DeviceSelector/MetronomeMidiSettings';

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
  const [showMidiPopup, setShowMidiPopup] = useState(false);
  const [showMetronomeSettings, setShowMetronomeSettings] = useState(false);
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
            <div className="flex gap-2 items-center">
              <button
                className="text-amber-800 px-2 py-1 rounded hover:bg-amber-200 border-amber-700 border-2 rounded-e-md text-sm"
                onClick={() => setShowMetronomeSettings(true)}
                title="Metronome Settings"
              >
                Metronome
              </button>
              <button
                className="text-green-700 px-2 py-1 rounded hover:bg-green-200 border-green-600 border-2 rounded-e-md text-sm"
                onClick={() => setShowMidiPopup(true)}
                title="MIDI Settings"
              >
                MIDI
              </button>
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
          {showMetronomeSettings && (
            <div
              className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50"
              onClick={() => setShowMetronomeSettings(false)}
              aria-modal="true"
              role="dialog"
            >
              <div className="bg-white p-4 rounded shadow-lg relative" onClick={(e) => e.stopPropagation()}>
                <button
                  className="absolute top-2 right-2 text-gray-500 hover:text-black text-xl font-bold focus:outline-none"
                  aria-label="Close"
                  onClick={() => setShowMetronomeSettings(false)}
                >
                  ×
                </button>
                <MetronomeMidiSettings />
              </div>
            </div>
          )}
          {/* MIDI Popup */}
          {showMidiPopup && (
            <div
              className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50"
              onClick={() => setShowMidiPopup(false)}
              aria-modal="true"
              role="dialog"
            >
              <div
                className="bg-white rounded shadow-lg p-6 min-w-[320px] relative"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="absolute top-2 right-2 text-gray-500 hover:text-gray-700 text-xl"
                  onClick={() => setShowMidiPopup(false)}
                  aria-label="Close MIDI Settings"
                >
                  ×
                </button>
                <h2 className="text-lg font-bold mb-4">MIDI Settings</h2>
                <MidiSelector />
              </div>
            </div>
          )}
          {children}
          <TanStackRouterDevtools position="bottom-right" />
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}
