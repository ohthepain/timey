import React, { useState, useEffect } from 'react';
import TempoService from '~/lib/MidiSync/TempoService';

export function TempoInput() {
  const [tempo, setTempo] = useState<number>(TempoService.bpm);

  useEffect(() => {
    setTempo(TempoService.bpm);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (!isNaN(value)) {
      setTempo(value);
      TempoService.setTempo(value);
    }
  };

  const handleIncrement = () => {
    setTempo((prev) => {
      const next = prev + 1;
      TempoService.setTempo(next);
      return next;
    });
  };

  const handleDecrement = () => {
    setTempo((prev) => {
      const next = prev - 1;
      TempoService.setTempo(next);
      return next;
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        className="w-8 h-8 flex items-center justify-center bg-gray-200 rounded hover:bg-gray-300 text-xl"
        onClick={handleDecrement}
        aria-label="Decrease tempo"
      >
        -
      </button>
      <input
        type="text"
        value={tempo}
        onChange={handleChange}
        className="w-12 h-12 text-center text-2xl border rounded appearance-none"
        inputMode="numeric"
        pattern="[0-9]*"
      />
      <button
        className="w-8 h-8 flex items-center justify-center bg-gray-200 rounded hover:bg-gray-300 text-xl"
        onClick={handleIncrement}
        aria-label="Increase tempo"
      >
        +
      </button>
    </div>
  );
}
