import { useEffect, useState } from 'react';
import { saveBeatServerFn } from '~/services/beatService.server';
import type { Beat } from '~/types/Beat';
import { Module } from '~/types/Module';
import { BarDefEditor } from '~/components/BarDefEditor';
import { BeatSource, BarSource } from '~/types/BarSource';
import { ParseBeatSource, ParseBeatString } from '~/lib/ParseBeat';
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

export const  BeatEditor = ({ beat, module }: BeatEditorProps) => {
  const [name, setName] = useState(beat?.name || 'Basic Beat');
  const [index, setIndex] = useState(beat?.index || 1);
  const [beatSource, setBeatSource] = useState<BeatSource>(new BeatSource([]));
  const [tempBeat, setTempBeat] = useState<Beat>(beat || makeTempBeat(module.id));
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();

  const kickStr = 'k,,,,k,,,';
  const hihatStr = 'h,h,h,h,h,h,h,h';
  const snareStr = ',,s,,,,s,';
  const accentStr = 'a,,a,,a,,a,';

  const handleSave = async () => {
    console.log(`Saving beat: index ${index}`);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    const beatString = ParseBeatSource(beatSource);
    console.log('Beat string:', beatString);

    try {
      const savedBeat = await saveBeatServerFn({
        data: { ...tempBeat, name, index },
      });

      setName('');
      setIndex(0);
      setError(null);
      setBeatSource(new BeatSource([]));
      router.invalidate();
    } catch (err) {
      console.error('Error adding beat:', err);
      setError('Failed to add beat');
    }
  };

  const addBarDef = () => {
    const newBarSource: BarSource = { kick: kickStr, hihat: hihatStr, snare: snareStr, accent: accentStr };
    setBeatSource(new BeatSource([...beatSource.bars, newBarSource]));
  };

  const copyBar = () => {
    if (beatSource.bars.length === 0) {
      return;
    }
    setBeatSource(new BeatSource([...beatSource.bars, beatSource.bars[beatSource.bars.length - 1]]));
  };

  const deleteBar = (index: number) => {
    const newBars = [...beatSource.bars];
    newBars.splice(index, 1);
    setBeatSource(new BeatSource(newBars));
  };

  const handleBarDefChange = (index: number, updatedBarDef: BarSource) => {
    console.log('Updated bar def:', index, updatedBarDef);
    const newBars = beatSource.bars.map((barDef, i) => (i === index ? updatedBarDef : barDef));
    setBeatSource(new BeatSource(newBars));
  };

  useEffect(() => {
    const beatString = ParseBeatSource(beatSource);
    console.log('Beat string:', beatString);

    const { beatNotes } = ParseBeatString(beatString);

    const newTempBeat = {
      ...tempBeat,
      beatNotes: beatNotes,
    };
    console.log('New temp beat:', newTempBeat);
    setTempBeat(newTempBeat);
  }, [beatSource]);

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
        {beatSource.bars.map((barSource, index) => (
          <div className="inline-flex bg-pink-100 m-2" key={index}>
            <BarDefEditor
              barSource={barSource}
              onDelete={() => deleteBar(index)}
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
            onClick={copyBar}
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
