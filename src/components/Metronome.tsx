import React from 'react';

interface MetronomeProps {
  currentBeat: number;
  beatsPerBar: number;
}

export const Metronome = ({ currentBeat, beatsPerBar }: MetronomeProps) => (
  <div className="flex space-x-2 mb-4 bg-red-200">
    Metronome
    {Array.from({ length: beatsPerBar }).map((_, i) => (
      <div
        key={i}
        className={`w-4 h-4 rounded-full transition-all duration-100 ${
          i === currentBeat ? 'bg-red-500 scale-125' : 'bg-gray-300'
        }`}
      />
    ))}
  </div>
);
