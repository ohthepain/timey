import { useEffect, useState } from 'react';
import { TempoService } from '~/lib/TempoService';
import { Metronome } from './Metronome';
import { TempoInput } from './TempoInput';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import { deletePerformancesByBeatIdAndUserId } from '~/services/performanceService.server';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const { currentBeat, getPerformancesForBeatId } = useNavigationStore();
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
  };

  const handleStop = () => {
    console.log('Stop clicked');
    tempoService.stop();
    setIsRunning(false);
    setIsPlaying(false);
    setIsRecording(false);
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
              onClick={handleStop}
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
                console.log('Start clicked');
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
