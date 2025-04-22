import { useState } from 'react';
import { BarSource } from '~/types/BarSource';

interface BarDefEditorProps {
  barSource: BarSource;
  onDelete: () => void;
  onChange?: (barDef: BarSource) => void;
}

export const BarDefEditor = ({ barSource, onDelete, onChange }: BarDefEditorProps) => {
  const [kick, setKick] = useState(barSource.kick);
  const [hihat, setHihat] = useState(barSource.hihat);
  const [snare, setSnare] = useState(barSource.snare);
  const [accent, setAccent] = useState(barSource.accent);

  const handleDelete = () => {
    onDelete();
  };

  const handleChange = (updatedBarDef: BarSource) => {
    if (onChange) onChange(updatedBarDef);
  };

  return (
    <div className="beat-string-editor w-52 p-4 border rounded shadow-md bg-orange-50">
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Kick</label>
          <button
            type="button"
            className="text-xs bg-gray-200 hover:bg-gray-300 rounded px-2 py-1"
            onClick={() => {
              setKick('');
              handleChange({
                ...barSource,
                kick: '',
              });
            }}
            title="Clear kick"
          >
            Clear
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={kick}
            onChange={(e) => {
              setKick(e.target.value);
              handleChange({
                ...barSource,
                kick: e.target.value,
              });
            }}
            className="input-field px-4 py-2 border rounded w-full"
          />
        </div>
      </div>
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Hihat</label>
          <button
            type="button"
            className="text-xs bg-gray-200 hover:bg-gray-300 rounded px-2 py-1"
            onClick={() => {
              setHihat('');
              handleChange({
                ...barSource,
                hihat: '',
              });
            }}
            title="Clear kick"
          >
            Clear
          </button>
        </div>
        <input
          type="text"
          value={hihat}
          onChange={(e) => {
            setHihat(e.target.value);
            handleChange({
              ...barSource,
              kick,
              hihat: e.target.value,
              snare,
              accent,
            });
          }}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Snare</label>
          <button
            type="button"
            className="text-xs bg-gray-200 hover:bg-gray-300 rounded px-2 py-1"
            onClick={() => {
              setSnare('');
              handleChange({
                ...barSource,
                snare: '',
              });
            }}
            title="Clear kick"
          >
            Clear
          </button>
        </div>
        <input
          type="text"
          value={snare}
          onChange={(e) => {
            setSnare(e.target.value);
            handleChange({
              ...barSource,
              kick,
              hihat,
              snare: e.target.value,
              accent,
            });
          }}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Accent</label>
          <button
            type="button"
            className="text-xs bg-gray-200 hover:bg-gray-300 rounded px-2 py-1"
            onClick={() => {
              setAccent('');
              handleChange({
                ...barSource,
                accent: '',
              });
            }}
            title="Clear accent"
          >
            Clear
          </button>
        </div>
        <input
          type="text"
          value={accent}
          onChange={(e) => {
            setAccent(e.target.value);
            handleChange({
              ...barSource,
              kick,
              hihat,
              snare,
              accent: e.target.value,
            });
          }}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <button
        onClick={handleDelete}
        className="btn btn-delete bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
      >
        Delete
      </button>
    </div>
  );
};
