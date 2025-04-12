import { useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';
import MidiSelector from '~/components/DeviceSelector/MidiSelector';
import { useScoreStore } from '~/state/ScoreStore';
import { BeatAdminOperations } from '~/components/BeatAdminOperations';

export const Transport = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [beatName, setBeatName] = useState('basic');

  const handleSave = async () => {
    console.log('handleSave');
    const beatName = 'basic';
    const beatString = useScoreStore.getState().getBeat(beatName);
    if (!beatString) {
      console.error('Beat not found');
      return;
    }

    try {
      console.log('handleSave: got beatString - sending request');
      const response = await fetch('/api/saveBeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: beatName,
          beatString,
        }),
      });
      console.log(`handleSave: got beatString - got response status ${response.status}`);

      if (!response.ok) {
        throw new Error('Failed to save beat');
      }

      const savedBeat = await response.json();
      console.log('Beat saved successfully:', savedBeat);
    } catch (error) {
      console.error('Error saving beat:', error);
    }
  };

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
    <div className="transport-controls flex gap-4 p-4 bg-green-100 rounded">
      <BeatAdminOperations />
      <input
        type="text"
        placeholder="Enter beat name"
        value={beatName}
        onChange={(e) => setBeatName(e.target.value)}
        className="input-field px-4 py-2 border rounded"
      />
      <button className="btn btn-prev bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded" onClick={handleSave}>
        Save
      </button>
      <button className="btn btn-prev bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded" onClick={handlePrev}>
        Prev
      </button>
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
      <button className="btn btn-next bg-gray-300 hover:bg-gray-400 px-4 py-2 rounded" onClick={handleNext}>
        Next
      </button>
      <MidiSelector />
    </div>
  );
};
