import { useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);

  const handlePlay = () => {
    console.log('Play clicked');
    TempoService.start();
  };

  const handleStop = () => {
    console.log('Stop clicked');
    TempoService.stop();
    setIsRunning(false);
  };

  const handlePrev = () => {
    console.log('Prev clicked');
    // Logic for moving to the previous section or bar
    const currentSpp = Math.max(TempoService.currentSpp - 16, 0); // Move back 1 bar (assuming 4/4 time)
    TempoService.currentSpp = currentSpp;
    TempoService.eventsEmitter.emit('SPP', { spp: currentSpp });
  };

  const handleNext = () => {
    console.log('Next clicked');
    // Logic for moving to the next section or bar
    const currentSpp = TempoService.currentSpp + 16; // Move forward 1 bar (assuming 4/4 time)
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
    <div className="transport-controls flex gap-4 p-4 bg-gray-100 rounded">
      <button
        className="btn btn-prev bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded"
        onClick={handlePrev}
      >
        Prev
      </button>
      {isRunning ? (
        <button
          className="btn btn-stop bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
          onClick={handleStop}
        >
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
      <button
        className="btn btn-next bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded"
        onClick={handleNext}
      >
        Next
      </button>
    </div>
  );
};
