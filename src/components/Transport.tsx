import { useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';
import { Metronome } from './Metronome';
import { TempoInput } from './TempoInput';
import { set } from 'zod';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlayButton = () => {
    console.log('Transport: handlePlayButton');
    TempoService.play();
    setIsRunning(true);
    setIsPlaying(true);
  };

  const handleRecordButton = () => {
    console.log('Transport: handleRecordButton');
    TempoService.record();
    setIsRunning(true);
    setIsRecording(true);
  };

  const handleStop = () => {
    console.log('Stop clicked');
    TempoService.stop();
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
    <div className="transport-controls flex gap-4 p-4 items-center">
      {isRunning && isPlaying ? (
        <button className="btn btn-stop bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded" onClick={handleStop}>
          Stop
        </button>
      ) : (
        <button
          className="btn btn-play bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          onClick={handlePlayButton}
        >
          Play
        </button>
      )}
      {isRunning && isRecording ? (
        <button className="btn btn-stop bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded" onClick={handleStop}>
          Stop
        </button>
      ) : (
        <button
          className="btn btn-play bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          onClick={handleRecordButton}
        >
          Record
        </button>
      )}
      <TempoInput />
      <Metronome beatsPerBar={4} />
    </div>
  );
};
