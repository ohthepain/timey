import { privatePractice } from '~/state/privatePractice';
import { useState, useSyncExternalStore } from 'react';
import { TempoService } from '~/lib/TempoService';
import { Metronome } from './Metronome';
import { TempoInput } from './TempoInput';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import { deletePerformancesByBeatIdAndUserId } from '~/services/performanceService.server';
import { EventRecorderService } from '~/lib/EventRecorderService';
import { usePersistedStore } from '~/state/PersistedStore';

export const Transport = () => {
  const { currentBeat, getPerformancesForBeatId } = useNavigationStore();
  const practiceUserId = useNavigationStore((state) => state.practiceUserId);
  const [failure, setFailure] = useState('');
  const { devMode } = usePersistedStore();

  const tempoService = TempoService.getInstance();
  const { isRunning, isRecording } = useSyncExternalStore(
    tempoService.subscribeTransportState,
    tempoService.getTransportState,
    tempoService.getTransportState
  );
  const beatRecorder = BeatRecorder.getInstance();
  const handlePlayButton = () => tempoService.play();
  const handleRecordButton = () => tempoService.record();

  function downloadCSV(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
  }

  const handleStop = async () => {
    console.log('Stop clicked');
    const wasRecording = tempoService.isRecording;
    tempoService.stop();

    if (devMode && wasRecording) {
      const eventRecorder = EventRecorderService.getInstance();
      const csv = eventRecorder.toCsv();
      downloadCSV('live.csv', csv);
      eventRecorder.clear();
    }
  };

  const handleReplay = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';

    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const eventRecorder = EventRecorderService.getInstance();
      const reader = new FileReader();

      reader.onload = (event) => {
        if (tempoService.isRunning) {
          alert('Stop practice before replaying.');
          return;
        }
        const content = event.target?.result as string;
        try {
          eventRecorder.loadFromCsvText(content);
          beatRecorder.replay();
        } catch (error) {
          console.error('Replay failed:', error);
          alert('Unable to replay this recording.');
          return;
        }

        // Create replay filename by adding '-replay' before the extension
        const filename = file.name;
        const lastDotIndex = filename.lastIndexOf('.');
        const replayFilename = filename.slice(0, lastDotIndex) + '-replay' + filename.slice(lastDotIndex);
        eventRecorder.saveToCsv(replayFilename);
      };

      reader.onerror = () => alert('Unable to read this recording.');
      reader.readAsText(file);
    };

    input.click();
  };

  return (
    <div className="transport-controls flex gap-1 p-4 items-center">
      <div className="flex flex-col w-full">
        {failure && <p role="alert">{failure}</p>}
        {!practiceUserId && (
          <a
            href={
              '/auth/login?returnTo=' +
              encodeURIComponent(typeof window === 'undefined' ? '/' : window.location.pathname)
            }
          >
            Sign in to save recordings
          </a>
        )}
        <div className="flex">
          {isRunning && !isRecording ? (
            <button
              className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                await handleStop();
              }}
            >
              Stop
            </button>
          ) : (
            <button
              className="text-green-700 px-2 m-1 rounded hover:bg-red-200 border-green-600 border-2 rounded-e-md text-sm"
              onClick={handlePlayButton}
            >
              Play
            </button>
          )}
          {isRunning && isRecording ? (
            <button
              className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
              onClick={handleStop}
            >
              Stop
            </button>
          ) : (
            <button
              className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
              onClick={handleRecordButton}
            >
              Record
            </button>
          )}
          {!isRunning && practiceUserId && (
            <button
              className="text-blue-700 px-2 m-1 rounded hover:bg-blue-200 border-blue-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                try {
                  await beatRecorder.savePerformance();
                  setFailure('');
                } catch {
                  setFailure('Unable to save recording. Sign in or retry.');
                }
              }}
            >
              Save
            </button>
          )}
          {!isRunning && currentBeat && currentBeat.id && (
            <button
              className="text-orange-700 px-2 m-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                console.log('Replay clicked');
                handleReplay();
              }}
            >
              {`Replay (${getPerformancesForBeatId(currentBeat.id).length})`}
            </button>
          )}
          {!isRunning && practiceUserId && currentBeat && currentBeat.id && (
            <button
              className="text-orange-700 px-2 m-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                try {
                  const deleted = await privatePractice(() =>
                    deletePerformancesByBeatIdAndUserId({ data: { beatId: currentBeat.id! } })
                  );
                  if (deleted) {
                    useNavigationStore.getState().clearPerformancesForBeatId(currentBeat.id!);
                    useNavigationStore.getState().setCurrentPerformance(null);
                  }
                  setFailure('');
                } catch {
                  setFailure('Unable to delete recordings. Sign in or retry.');
                }
              }}
            >
              {`Delete ${getPerformancesForBeatId(currentBeat.id).length} recordings`}
            </button>
          )}
          <TempoInput />
          <Metronome beatsPerBar={4} />
        </div>
      </div>
    </div>
  );
};
