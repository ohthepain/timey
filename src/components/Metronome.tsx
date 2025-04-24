import { useRef, useEffect, useState } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';

interface MetronomeProps {
  beatsPerBar: number;
}

export const Metronome = ({ beatsPerBar }: MetronomeProps) => {
  const [beatNum, setBeatNum] = useState(0);
  var nextNoteStartTicks: number = 0;
  const nextNoteStartTicksRef = useRef(nextNoteStartTicks);

  const handlePlay = () => {
    console.log('BeatPlayer: handlePlay');
    setBeatNum(0);
    nextNoteStartTicksRef.current = TempoService.ppqn;
  };

  const handleStop = () => {
    console.log('BeatPlayer: handleStop');
  };

  const handleMidiPulse = (event: { time: number; ticks: number }) => {
    if (event.ticks >= nextNoteStartTicksRef.current) {
      nextNoteStartTicksRef.current = nextNoteStartTicksRef.current + TempoService.ppqn;
      setBeatNum((beatNum) => (beatNum + 1) % beatsPerBar);
    }
  };

  useEffect(() => {
    TempoService.eventsEmitter.addListener('start', handlePlay.bind(this));
    TempoService.eventsEmitter.addListener('stop', handleStop.bind(this));
    TempoService.eventsEmitter.addListener('MIDI pulse', handleMidiPulse.bind(this));

    return () => {
      TempoService.eventsEmitter.removeListener('MIDI pulse', handleMidiPulse.bind(this));
      TempoService.eventsEmitter.removeListener('play', handlePlay.bind(this));
      TempoService.eventsEmitter.removeListener('stop', handleStop.bind(this));
    };
  }, []);

  return (
    <div className="flex space-x-2 mb-4">
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
