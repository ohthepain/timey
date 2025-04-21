import { useEffect, useState } from 'react';
import { saveBeatServerFn } from '~/services/beatService.server';
import type { Beat } from '~/types/Beat';
import { Module } from '~/types/Module';
import { BarDefEditor } from '~/components/BarDefEditor';
import { BarDef } from '~/types/BarDef';
import { ParseBeatStrings, ParseBeatString } from '~/lib/ParseBeat';
import { ScoreView } from '~/components/ScoreView2';
import { useRouter } from '@tanstack/react-router';

interface BeatEditorProps {
  beat: Beat | null;
  module: Module;
}

const makeTempBeat = (moduleId: string) => {
  return {
    id: undefined,
    name: 'temp',
    index: 0,
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: [],
    description: 'Default description',
    moduleId,
  } as Beat;
};

export const BeatEditor = ({ beat, module }: BeatEditorProps) => {
  const [name, setName] = useState('Basic Beat');
  const [index, setIndex] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [barDefs, setBarDefs] = useState<BarDef[]>([]);
  const [tempBeat, setTempBeat] = useState<Beat>(makeTempBeat(module.id));

  const router = useRouter();

  const hihatStr = 'h,h,h,h,h,h,h,h';
  const kickStr = 'k,,,,k,,,';
  const snareStr = ',,s,,,,s,';
  const accentStr = 'a,,a,,a,,a,';
  const kickStr1 = 'k,kk,,,k,xkk,xk,';
  const snareStr1 = ',,s,xs,xss,s,,xs';

  const handleSave = async () => {
    console.log(`Saving beat: index ${index}`);
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

    try {
      console.log('Saving beat...: beat.id, module.id', beat?.id, module.id);
      console.log(`Saving beat: index ${index}`);

      const savedBeat = await saveBeatServerFn({
        data: { ...tempBeat, name, index },
      });

      console.log('Beat saved successfully:', savedBeat);
      setName('');
      setIndex(0);
      setError(null);
      setBarDefs([]);
      router.invalidate();
    } catch (err) {
      console.error('Error adding beat:', err);
      setError('Failed to add beat');
    }
  };

  const addBarDef = () => {
    const newBarDef = { kick: kickStr, hihat: hihatStr, snare: snareStr, accent: accentStr };
    setBarDefs([...barDefs, newBarDef]);
  };

  const copyBarDef = () => {
    let newBarDef: BarDef;
    if (barDefs.length > 0) {
      // Copy the last barDef
      newBarDef = { ...barDefs[barDefs.length - 1] };
    } else {
      newBarDef = { kick: kickStr, hihat: hihatStr, snare: snareStr, accent: accentStr };
    }
    setBarDefs([...barDefs, newBarDef]);
  };

  const deleteBarDef = (index: number) => {
    const updatedBarDefs = [...barDefs];
    updatedBarDefs.splice(index, 1);
    setBarDefs(updatedBarDefs);
  };

  const handleBarDefChange = (index: number, updatedBarDef: BarDef) => {
    console.log('Updated bar def:', index, updatedBarDef);
    const newBarDefs = barDefs.map((barDef, i) => (i === index ? updatedBarDef : barDef));
    setBarDefs(newBarDefs);
  };

  useEffect(() => {
    const beatStrings = [
      barDefs.map((barDef) => barDef.hihat),
      barDefs.map((barDef) => barDef.kick),
      barDefs.map((barDef) => barDef.snare),
    ];
    console.log('Beat strings:', beatStrings);

    const beatString = ParseBeatStrings(beatStrings);
    console.log('Beat string:', beatString);

    const { beatNotes } = ParseBeatString(beatString);

    const newTempBeat = {
      ...tempBeat,
      beatNotes: beatNotes,
    };
    console.log('New temp beat:', newTempBeat);
    setTempBeat(newTempBeat);
  }, [barDefs]);

  useEffect(() => {
    console.log(`Index changed: ${index}`);
  }, [index]);

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
            <BarDefEditor
              barDef={barDef}
              onDelete={() => deleteBarDef(index)}
              onChange={(updatedBarDef) => handleBarDefChange(index, updatedBarDef)}
            />
          </div>
        ))}
        <div className="flex flex-col">
          <button
            onClick={addBarDef}
            className="btn btn-add bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded mb-4 m-2"
          >
            Add Bar
          </button>
          <button
            onClick={copyBarDef}
            className="btn btn-add bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded mb-4 m-2"
          >
            Copy Bar
          </button>
        </div>
      </div>
      <ScoreView beat={tempBeat} />
    </div>
  );
};
