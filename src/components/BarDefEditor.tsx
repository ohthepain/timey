import { useState } from 'react';
import { BarDef } from '~/types/BarDef';

interface BarDefEditorProps {
  barDef: BarDef;
  onDelete: () => void;
}

export const BarDefEditor = ({ barDef, onDelete }: BarDefEditorProps) => {
  const [kick, setKick] = useState(barDef.kick);
  const [hihat, setHihat] = useState(barDef.hihat);
  const [snare, setSnare] = useState(barDef.snare);
  const [accent, setAccent] = useState(barDef.accent);

  const handleDelete = () => {
    onDelete();
  };

  return (
    <div className="beat-string-editor w-52 p-4 border rounded shadow-md bg-orange-50">
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Kick</label>
        <input
          type="text"
          value={kick}
          onChange={(e) => setKick(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Hihat</label>
        <input
          type="text"
          value={hihat}
          onChange={(e) => setHihat(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Snare</label>
        <input
          type="text"
          value={snare}
          onChange={(e) => setSnare(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Accent</label>
        <input
          type="text"
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <button
        onClick={handleDelete}
        className="btn btn-save bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
      >
        Delete
      </button>
    </div>
  );
};
