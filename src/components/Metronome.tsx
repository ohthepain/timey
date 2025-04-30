import { useRef, useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';
import '~/lib/MetronomeService'; // Side-effects import
import { useNavigationStore } from '~/state/NavigationStore';
import { GoMute, GoUnmute } from 'react-icons/go';

interface MetronomeProps {
  beatsPerBar: number;
}

export const Metronome = ({ beatsPerBar }: MetronomeProps) => {
  const [beatNum, setBeatNum] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  var nextNoteStartTicks: number = 0;
  const nextNoteStartTicksRef = useRef(nextNoteStartTicks);
  const { isMetronomeOn, setMetronomeOn } = useNavigationStore();

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
    TempoService.eventsEmitter.addListener('stateChange', handleStateChange);
    TempoService.eventsEmitter.addListener('MIDI pulse', handleMidiPulse);

    return () => {
      TempoService.eventsEmitter.removeListener('MIDI pulse', handleMidiPulse);
      TempoService.eventsEmitter.removeListener('stateChange', handleStateChange);
    };
  }, []);

  return (
    <div className="flex space-x-2 items-center" onClick={() => setMetronomeOn(!isMetronomeOn)}>
      {Array.from({ length: beatsPerBar }).map((_, i) => (
        <div
          key={i}
          className={`w-4 h-4 rounded-full transition-all duration-100 ${
            i === beatNum ? 'bg-red-500 scale-125' : 'bg-gray-300'
          }`}
        />
      ))}
      <label className="flex items-center gap-2 text-xl font-bold">
        {isMetronomeOn ? (
          <span title="Metronome On" role="img" aria-label="Ear">
            <GoUnmute />
          </span>
        ) : (
          <span title="Metronome Off" role="img" aria-label="Ear with slash">
            <GoMute />
          </span>
        )}
      </label>
    </div>
  );
};
