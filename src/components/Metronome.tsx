import { useRef, useEffect, useState } from 'react';
import { tempoService } from '~/lib/MidiSync/TempoService';
import '~/lib/MetronomeService'; // Side-effects import
import { useNavigationStore } from '~/state/NavigationStore';
import { GoMute, GoUnmute } from 'react-icons/go';
import MetronomeMidiSettings from './DeviceSelector/MetronomeMidiSettings';

interface MetronomeProps {
  beatsPerBar: number;
}

export const Metronome = ({ beatsPerBar }: MetronomeProps) => {
  const [beatNum, setBeatNum] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  var nextNoteStartTicks: number = 0;
  const nextNoteStartTicksRef = useRef(nextNoteStartTicks);
  const { isMetronomeOn, setMetronomeOn } = useNavigationStore();
  const [showSettings, setShowSettings] = useState(false);

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
    nextNoteStartTicksRef.current = tempoService.ppqn;
  };

  const handleStop = () => {
    console.log('Metronome: handleStop');
    setIsRunning(false);
  };

  const handleMidiPulse = (event: { time: number; ticks: number }) => {
    if (event.ticks >= nextNoteStartTicksRef.current) {
      nextNoteStartTicksRef.current = nextNoteStartTicksRef.current + tempoService.ppqn;
      setBeatNum((beatNum) => (beatNum + 1) % beatsPerBar);
    }
  };

  useEffect(() => {
    tempoService.eventsEmitter.addListener('stateChange', handleStateChange);
    tempoService.eventsEmitter.addListener('MIDI Clock Pulse', handleMidiPulse);

    return () => {
      tempoService.eventsEmitter.removeListener('MIDI Clock Pulse', handleMidiPulse);
      tempoService.eventsEmitter.removeListener('stateChange', handleStateChange);
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
      {/* Settings Button */}
      <button
        type="button"
        className="ml-2 px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-xs"
        onClick={(e) => {
          e.stopPropagation();
          setShowSettings(true);
        }}
      >
        Metronome MIDI Settings
      </button>
      {/* Modal or Inline Settings */}
      {showSettings && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50"
          onClick={() => setShowSettings(false)}
        >
          <div className="bg-white p-4 rounded shadow-lg relative" onClick={(e) => e.stopPropagation()}>
            <button
              className="absolute top-2 right-2 text-gray-500 hover:text-black text-xl font-bold focus:outline-none"
              aria-label="Close"
              onClick={() => setShowSettings(false)}
            >
              ×
            </button>
            <MetronomeMidiSettings />
          </div>
        </div>
      )}
    </div>
  );
};
