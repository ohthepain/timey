import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary';
import { NotFound } from '~/components/NotFound';
import appCss from '~/styles/app.css?url';
import { seo } from '~/utils/seo';
import { useState } from 'react';
import MidiSelector from '~/components/DeviceSelector/MidiSelector';
import MetronomeMidiSettings from '~/components/DeviceSelector/MetronomeMidiSettings';
import { AppHeader } from '~/components/AppHeader';
import { SettingsModal } from '~/components/SettingsModal';
import { useRestoreLastUrl } from '~/hooks/useRestoreLastUrl';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({
        title: 'themethod.live',
        description: `TheMethod is the fastest way to learn drums on your TD-27. `,
      }),
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
      { rel: 'manifest', href: '/site.webmanifest', color: '#fffff' },
      { rel: 'icon', href: '/favicon.ico' },
    ],
  }),
  errorComponent: (props) => (
    <>
      <RootComponent />
      <DefaultCatchBoundary {...props} />
    </>
  ),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function RootComponent() {
  useRestoreLastUrl();
  const [showMidiPopup, setShowMidiPopup] = useState(false);
  const [showMetronomeSettings, setShowMetronomeSettings] = useState(false);

  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppHeader onOpenMetronome={() => setShowMetronomeSettings(true)} onOpenMidi={() => setShowMidiPopup(true)} />
        <hr />
        <SettingsModal
          open={showMetronomeSettings}
          onClose={() => setShowMetronomeSettings(false)}
          overlayClassName="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50"
          panelClassName="bg-white p-4 rounded shadow-lg relative"
        >
          <MetronomeMidiSettings />
        </SettingsModal>
        <SettingsModal open={showMidiPopup} onClose={() => setShowMidiPopup(false)} title="MIDI Settings">
          <MidiSelector />
        </SettingsModal>
        <Outlet />
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
