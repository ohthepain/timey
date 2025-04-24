import { useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';
import { Metronome } from './Metronome';
import { TempoInput } from './TempoInput';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const handlePlay = () => {
    console.log('Play clicked');
    TempoService.start();
  };

  const handleRecord = () => {
    console.log('Play clicked');
    TempoService.start();
  };

  const handleStop = () => {
    console.log('Stop clicked');
    TempoService.stop();
    setIsRunning(false);
    setIsRecording(false);
  };

  const handlePrev = () => {
    console.log('Prev clicked');
    const currentSpp = Math.max(TempoService.currentSpp - 16, 0);
    TempoService.currentSpp = currentSpp;
    TempoService.eventsEmitter.emit('SPP', { spp: currentSpp });
  };

  const handleNext = () => {
    console.log('Next clicked');
    const currentSpp = TempoService.currentSpp + 16;
    TempoService.currentSpp = currentSpp;
    TempoService.eventsEmitter.emit('SPP', { spp: currentSpp });
  };

  useEffect(() => {
    // Listen for changes in TempoService's running state
    const updateRunningState = () => {
      setIsRunning(TempoService.isRunning);
    };

    TempoService.eventsEmitter.on('stateChange', updateRunningState);

    return () => {
      TempoService.eventsEmitter.off('stateChange', updateRunningState);
    };
  }, []);

  return (
    <div className="transport-controls flex gap-4 p-4 align-center">
      {/* <button className="btn btn-prev bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded" onClick={handlePrev}>
        Prev
      </button> */}
      {isRunning ? (
        <button className="btn btn-stop bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded" onClick={handleStop}>
          Stop
        </button>
      ) : (
        <button
          className="btn btn-play bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          onClick={handlePlay}
        >
          Play
        </button>
      )}
      {isRunning ? (
        <button className="btn btn-stop bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded" onClick={handleStop}>
          Stop
        </button>
      ) : (
        <button
          className="btn btn-play bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          onClick={handleRecord}
        >
          Record
        </button>
      )}
      {/* <button className="btn btn-next bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded" onClick={handleNext}>
        Next
      </button> */}
      <TempoInput />
      <Metronome beatsPerBar={4} />
    </div>
  );
};
