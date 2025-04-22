import { useState } from 'react';
import { Beat } from '~/types/Beat';
import { Module } from '~/types/Module';
import { BeatEditor } from './BeatEditor';
import {
  BeatProgressView,
  passBeatTempoServerFn,
  startBeatServerFn,
} from '~/services/userProgressServerService.server';
import { useRouter } from '@tanstack/react-router';
import { deleteBeatServerFn } from '~/services/beatService.server';
import { ScoreView } from '~/components/ScoreView2';

interface BeatViewerProps {
  beat: Beat;
  module: Module;
  beatProgress: BeatProgressView | undefined;
}

export function BeatViewer({ beat, module, beatProgress }: BeatViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(beat.name);

  const router = useRouter();

  const handleDeleteBeat = async (beatId: string) => {
    try {
      await deleteBeatServerFn({ data: { id: beatId } });
      // Optionally, refresh the module or remove the beat from the UI
    } catch (error) {
      console.error('Error deleting beat:', error);
      alert('Failed to delete beat');
    }
  };

  const handleCopyBeat = async () => {};
  const handleEditBeat = async () => {
    setIsEditing(!isEditing);
  };

  return (
    <div>
      <div className="flex justify-between items-center">
        <div className="flex-col items-center">
          {isEditing ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field px-4 py-2 border rounded w-full"
            />
          ) : (
            <div className="font-semibold">{name}</div>
          )}
          <div className="flex flex-row">
            <button
              onClick={async () => {
                await startBeatServerFn({ data: { beatId: beat.id } });
                /* TODO: implement play functionality */
              }}
              className="text-green-500 hover:text-green-700 text-3xl p-1"
              title="Play"
            >
              ▶️
            </button>
            <button
              onClick={handleEditBeat}
              className="text-green-500 hover:text-green-700 text-xs px-1 mx-1 border border-green-500 rounded my-1.5"
              title="Edit"
            >
              Edit
            </button>
            <button
              onClick={handleCopyBeat}
              className="text-blue-500 hover:text-blue-700 text-xs px-1 mx-1 border border-blue-500 rounded my-1.5"
              title="Copy"
            >
              Copy
            </button>
            <button
              onClick={async () => {
                handleDeleteBeat(beat.id!);
                router.invalidate();
              }}
              className="text-red-500 hover:text-red-700 text-xs px-1 mx-1 border border-red-500 rounded my-1.5"
              title="Delete"
            >
              Delete
            </button>
          </div>
        </div>
        <ScoreView beat={beat} />
        {[90, 100, 120, 140].map((tempo) => {
          const bestTempo = beatProgress?.bestTempo || 0;
          const isBlue = bestTempo !== undefined && bestTempo >= tempo;
          return (
            <button
              key={tempo}
              onClick={async () => {
                await passBeatTempoServerFn({ data: { beatId: beat.id, tempo: tempo } });
              }}
              className={
                `font-bold py-1 px-2 mx-1 rounded text-xs ` +
                (isBlue ? 'bg-blue-500 text-white hover:bg-blue-700' : 'bg-blue-100 hover:bg-blue-300 text-blue-800')
              }
              title={`Pass at tempo ${tempo}`}
            >
              {tempo}
            </button>
          );
        })}
        <button onClick={() => handleDeleteBeat(beat.id!)} className="text-red-500 hover:text-red-700 text-sm">
          Delete
        </button>
      </div>
      {isEditing && (
        <BeatEditor
          beat={beat}
          module={module}
          onSave={() => {
            setIsEditing(false);
          }}
        />
      )}
    </div>
  );
}
