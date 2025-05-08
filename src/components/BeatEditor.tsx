import { useEffect, useState } from 'react';
import { saveBeatServerFn } from '~/services/beatService.server';
import { Beat } from '~/types/Beat';
import { Module } from '~/types/Module';
import { BarDefEditor } from '~/components/BarDefEditor';
import { BeatSource, BarSource } from '~/types/BarSource';
import { createBeatSourceFromBeat, ParseBeatSource, ParseBeatString } from '~/lib/ParseBeat';
import { ScoreView } from '~/components/ScoreView';
import { useRouter } from '@tanstack/react-router';

interface BeatEditorProps {
  beat: Beat | null;
  module: Module;
  onSave?: () => void;
}

const makeTempBeat = (moduleId: string): Beat => {
  return new Beat({
    id: undefined,
    name: 'temp',
    index: 0,
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: [],
    description: '',
    moduleId,
  });
};

export const BeatEditor = (props: BeatEditorProps) => {
  const module = props.module;
  const beat = props.beat || makeTempBeat(module.id);

  const [name, setName] = useState(beat.name);
  const [index, setIndex] = useState(beat.index);
  const [beatSource, setBeatSource] = useState<BeatSource>(createBeatSourceFromBeat(beat));
  const [tempBeat, setTempBeat] = useState<Beat>(beat || makeTempBeat(module.id));
  const [error, setError] = useState<string | null>(null);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [tempName, setTempName] = useState('');

  const router = useRouter();

  const kickStr = 'k,,,,k,,,';
  const hihatStr = 'h,h,h,h,h,h,h,h';
  const snareStr = ',,s,,,,s,';
  const accentStr = 'a,,a,,a,,a,';

  const handleSave = async () => {
    if (!name.trim()) {
      setTempName('');
      setShowNameDialog(true);
      return;
    }

    const beatString = ParseBeatSource(beatSource);
    console.log('Beat string:', beatString);
    console.log('tempBeat:', tempBeat);

    try {
      await saveBeatServerFn({
        data: { ...tempBeat, moduleId: module.id, name, index },
      });

      setName('');
      setIndex(0);
      setError(null);
      setBeatSource(new BeatSource([]));
      router.invalidate();
      if (props.onSave) {
        props.onSave();
      }
    } catch (err) {
      console.error('Error adding beat:', err);
      setError('Failed to add beat');
    }
  };

  const handleNameSubmit = () => {
    if (tempName.trim()) {
      setName(tempName);
      setShowNameDialog(false);
      handleSave();
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

    const newTempBeat = new Beat({
      ...tempBeat,
      beatNotes: beatNotes,
    });
    console.log('New temp beat:', newTempBeat);
    setTempBeat(newTempBeat);
  }, [beatSource]);

  return (
    <div>
      {error && <p className="text-red-500 mb-2">{error}</p>}
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
          <div className="mb-4 m-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 border rounded"
              placeholder="Enter beat name"
            />
          </div>
          <div className="mb-4 m-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Index</label>
            <input
              type="number"
              value={index}
              onChange={(e) => setIndex(parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2 border rounded"
              placeholder="Enter beat index"
            />
          </div>
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
          <button
            onClick={handleSave}
            className="btn btn-create bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded m-2"
          >
            Save
          </button>
        </div>
      </div>
      <ScoreView beat={tempBeat} />

      {/* Name Input Dialog */}
      {showNameDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Enter Beat Name</h3>
            <input
              type="text"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              className="w-full px-4 py-2 border rounded mb-4"
              placeholder="Enter beat name"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNameDialog(false)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleNameSubmit}
                className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
