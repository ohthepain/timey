import { useState, useSyncExternalStore } from 'react';
import { TempoService } from '~/lib/TempoService';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';
import { TransportControls } from '~/components/TransportControls';

export const Transport = () => {
  const practiceUserId = useNavigationStore((state) => state.practiceUserId);
  const [failure, setFailure] = useState('');
  const { devMode } = usePersistedStore();
  const tempoService = TempoService.getInstance();
  const { isRunning, isRecording } = useSyncExternalStore(
    tempoService.subscribeTransportState,
    tempoService.getTransportState,
    tempoService.getTransportState
  );

  const loginHref =
    '/auth/login?returnTo=' + encodeURIComponent(typeof window === 'undefined' ? '/' : window.location.pathname);

  return (
    <div className="transport-controls flex gap-1 p-4 items-center">
      <div className="flex flex-col w-full">
        {failure && <p role="alert">{failure}</p>}
        {!practiceUserId && <a href={loginHref}>Sign in to save recordings</a>}
        <TransportControls
          isRunning={isRunning}
          isRecording={isRecording}
          practiceUserId={practiceUserId}
          devMode={devMode}
          onFailure={setFailure}
          onClearFailure={() => setFailure('')}
          onPlay={() => tempoService.play()}
          onRecord={() => tempoService.record()}
        />
      </div>
    </div>
  );
};
