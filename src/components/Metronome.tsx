import { useRef, useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';

interface MetronomeProps {
  beatsPerBar: number;
}

export const Metronome = ({ beatsPerBar }: MetronomeProps) => {
  const [beatNum, setBeatNum] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  var nextNoteStartTicks: number = 0;
  const nextNoteStartTicksRef = useRef(nextNoteStartTicks);

  const handleStateChange = (state: { isRunning: boolean }) => {
    console.log('Metronome: handleStateChange', state);
    if (state.isRunning) {
      handleRun();
    } else {
      handleStop();
    }
  };

  const handleRun = () => {
    console.log('Metronome: handleRun');
    setBeatNum(0);
    setIsRunning(true);
    nextNoteStartTicksRef.current = TempoService.ppqn;
  };

  const handleStop = () => {
    console.log('Metronome: handleStop');
    setIsRunning(false);
  };

  const handleMidiPulse = (event: { time: number; ticks: number }) => {
    if (event.ticks >= nextNoteStartTicksRef.current) {
      nextNoteStartTicksRef.current = nextNoteStartTicksRef.current + TempoService.ppqn;
      setBeatNum((beatNum) => (beatNum + 1) % beatsPerBar);
    }
  };

  useEffect(() => {
    TempoService.eventsEmitter.addListener('stateChange', handleStateChange.bind(this));
    TempoService.eventsEmitter.addListener('MIDI pulse', handleMidiPulse.bind(this));

    return () => {
      TempoService.eventsEmitter.removeListener('MIDI pulse', handleMidiPulse.bind(this));
      TempoService.eventsEmitter.removeListener('stateChange', handleStateChange.bind(this));
    };
  }, []);

  return (
    <div className="flex space-x-2 items-center">
      {Array.from({ length: beatsPerBar }).map((_, i) => (
        <div
          key={i}
          className={`w-4 h-4 rounded-full transition-all duration-100 ${
            i === beatNum ? 'bg-red-500 scale-125' : 'bg-gray-300'
          }`}
        />
      ))}
    </div>
  );
};
