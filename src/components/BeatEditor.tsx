import { useState } from 'react';
import { saveBeat } from '~/services/beatService';
import type { Beat } from '~/types/Beat';
import { Module } from '~/types/Module';
import { BarDefEditor } from '~/components/BarDefEditor';
import { BarDef } from '~/types/BarDef';
import { ParseBeatStrings } from '~/lib/ParseBeat';
import { ScoreView } from '~/components/ScoreView2';

interface BeatEditorProps {
  beat: Beat | null;
  module: Module;
}

const makeTempBeat = () => {
  return {
    id: '0',
    name: 'temp',
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: [],
  } as Beat;
};

export const BeatEditor = ({ beat, module }: BeatEditorProps) => {
  const [name, setName] = useState('Basic Beat');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [barDefs, setBarDefs] = useState<BarDef[]>([]);
  const [tempBeat, setTempBeat] = useState<Beat>(makeTempBeat());

  const hihatStr = 'h,h,h,h,h,h,h,h';
  const kickStr = 'k,,,,k,,,';
  const snareStr = ',,s,,,,s,';
  const accentStr = 'a,,a,,a,,a,';
  const kickStr1 = 'k,kk,,,k,xkk,xk,';
  const snareStr1 = ',,s,xs,xss,s,,xs';

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    const beatStrings = [
      barDefs.map((barDef) => barDef.hihat),
      barDefs.map((barDef) => barDef.kick),
      barDefs.map((barDef) => barDef.snare),
    ];
    console.log('Beat strings:', beatStrings);

    const beatString = ParseBeatStrings(beatStrings);
    console.log('Beat string:', beatString);

    // try {
    //   console.log('Saving beat...: module', module);
    //   console.log('Saving beat...: module.id', module.id);
    //   await saveBeat(name, beatString, index, 'Default description', module.id);
    //   setName('');
    //   setIndex(0);
    //   setError(null);
    //   setBarDefs([]);
    //   alert('Beat added successfully');
    // } catch (err) {
    //   console.error('Error adding beat:', err);
    //   setError('Failed to add beat');
    // }
  };

  const addBarDef = () => {
    setBarDefs([...barDefs, { kick: kickStr, hihat: hihatStr, snare: snareStr, accent: accentStr }]);

    const beatNotes = barDefs.map((barDef) => ({
      kick: barDef.kick,
      hihat: barDef.hihat,
      snare: barDef.snare,
      accent: barDef.accent,
    }));
  };

  const deleteBarDef = (index: number) => {
    const updatedBarDefs = [...barDefs];
    updatedBarDefs.splice(index, 1);
    setBarDefs(updatedBarDefs);
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Save</h2>
      {error && <p className="text-red-500 mb-2">{error}</p>}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Index</label>
        <input
          type="number"
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <button
        onClick={handleSave}
        className="btn btn-create bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded m-2"
      >
        Save
      </button>
      <div className="bar-def-editors flex items-center">
        {barDefs.map((barDef, index) => (
          <div className="inline-flex bg-pink-100 m-2" key={index}>
            <BarDefEditor barDef={barDef} onDelete={() => deleteBarDef(index)} />
          </div>
        ))}
        <button
          onClick={addBarDef}
          className="btn btn-add bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded mb-4 m-2"
        >
          Add Bar
        </button>
      </div>
      <ScoreView beat={tempBeat} />
    </div>
  );
};
