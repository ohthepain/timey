import { useEffect, useState } from 'react';
import { TempoService } from '~/lib/TempoService';
import { Metronome } from './Metronome';
import { TempoInput } from './TempoInput';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import { deletePerformancesByBeatIdAndUserId } from '~/services/performanceService.server';
import { EventRecorderService } from '~/lib/EventRecorderService';
import { usePersistedStore } from '~/state/PersistedStore';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const { currentBeat, getPerformancesForBeatId } = useNavigationStore();
  const { devMode } = usePersistedStore();

  const tempoService = TempoService.getInstance();
  const beatRecorder = BeatRecorder.getInstance();
  const handlePlayButton = () => {
    console.log('Transport: handlePlayButton');
    tempoService.play();
    setIsRunning(true);
    setIsPlaying(true);
  };

  const handleRecordButton = () => {
    console.log('Transport: handleRecordButton');
    beatRecorder.start();
    // beatRecorder.setBeat(beat);
    tempoService.isRecording = true;

    setIsRunning(true);
    setIsRecording(true);

    tempoService.record();
  };

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
    const wasRecording = isRecording;
    tempoService.stop();
    setIsRunning(false);
    setIsPlaying(false);
    setIsRecording(false);

    if (devMode && wasRecording) {
      const eventRecorder = EventRecorderService.getInstance();
      const csv = eventRecorder.toCsv();
      downloadCSV('live.csv', csv);
    }
  };

  const handleReplay = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';

    // This is a hack to get the tempo service to record the replay. Currently starting a recording
    // also starts the callback timer.
    tempoService.isRecording = true;

    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const eventRecorder = EventRecorderService.getInstance();
      const reader = new FileReader();

      reader.onload = (event) => {
        const content = event.target?.result as string;
        eventRecorder.loadFromCsvText(content);
        eventRecorder.replay();

        // Create replay filename by adding '-replay' before the extension
        const filename = file.name;
        const lastDotIndex = filename.lastIndexOf('.');
        const replayFilename = filename.slice(0, lastDotIndex) + '-replay' + filename.slice(lastDotIndex);
        eventRecorder.saveToCsv(replayFilename);
      };

      reader.readAsText(file);
    };

    input.click();
  };

  useEffect(() => {
    // Listen for changes in TempoService's running state
    const tempoService_stateChange = (e: any) => {
      console.log(
        `Transport: tempoService_stateChange playing ${e.isPlaying} recording ${e.isRecording} running ${e.isRunning}`
      );
      setIsRunning(e.isRunning);
      setIsPlaying(e.isPlaying);
      setIsRecording(e.isRecording);
    };

    // TempoService.eventsEmitter.on('stateChange', tempoService_stateChange);

    // return () => {
    //   TempoService.eventsEmitter.off('stateChange', tempoService_stateChange);
    // };
  }, []);

  return (
    <div className="transport-controls flex gap-1 p-4 items-center">
      <div className="flex flex-col w-full">
        <div className="flex">
          {isRunning && isPlaying ? (
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
          {!isRunning && (
            <button
              className="text-blue-700 px-2 m-1 rounded hover:bg-blue-200 border-blue-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                console.log('Start clicked');
                beatRecorder.savePerformance();
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
          {!isRunning && currentBeat && currentBeat.id && (
            <button
              className="text-orange-700 px-2 m-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
              onClick={async () => {
                console.log('Start clicked');
                await deletePerformancesByBeatIdAndUserId({ data: { beatId: currentBeat.id } });
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
