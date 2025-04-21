import { useState } from 'react';
import { Module } from '~/types/Module';
import { ScoreView } from '~/components/ScoreView2';
import {
  passBeatTempoServerFn,
  startBeatServerFn,
  BeatProgressView,
} from '~/services/userProgressServerService.server';
import { deleteBeatServerFn } from '~/services/beatService.server';
import { useRouter } from '@tanstack/react-router';

export interface ModuleProps {
  module: Module;
  beatProgress: BeatProgressView[];
}

export const ModuleViewer = ({ module, beatProgress }: ModuleProps) => {
  const [beatProgressMap, setBeatProgressMap] = useState<Map<string, BeatProgressView>>(() => {
    const map = new Map<string, BeatProgressView>();
    beatProgress.forEach((beat) => {
      map.set(beat.beatId, beat);
    });
    return map;
  });

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
  const handleEditBeat = async () => {};

  return (
    <div className="module-page p-4">
      <h1 className="text-2xl font-bold mb-4">Module: {module.title}</h1>
      <p className="mb-2">Description: {module.description || 'No description provided.'}</p>
      <p className="mb-2">Index: {module.index}</p>
      <p className="mb-2">Author ID: {module.authorId}</p>
      <div className="mt-4">
        <h2 className="text-xl font-bold">Beats</h2>
        {module.beats && module.beats.length > 0 ? (
          <ul className="list-disc pl-5">
            {module.beats.map((beat) => (
              <li key={beat.id} className="mb-2">
                <div className="flex justify-between items-center">
                  <div className="flex-col items-center">
                    <p className="font-semibold">{beat.name}</p>
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
                    const bestTempo = beatProgressMap.get(beat.id!)?.bestTempo;
                    const isBlue = bestTempo !== undefined && bestTempo >= tempo;
                    return (
                      <button
                        key={tempo}
                        onClick={async () => {
                          await passBeatTempoServerFn({ data: { beatId: beat.id, tempo: tempo } });
                        }}
                        className={
                          `font-bold py-1 px-2 mx-1 rounded text-xs ` +
                          (isBlue
                            ? 'bg-blue-500 text-white hover:bg-blue-700'
                            : 'bg-blue-100 hover:bg-blue-300 text-blue-800')
                        }
                        title={`Pass at tempo ${tempo}`}
                      >
                        {tempo}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => handleDeleteBeat(beat.id!)}
                    className="text-red-500 hover:text-red-700 text-sm"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-500">No beats available for this module.</p>
        )}
      </div>
    </div>
  );
};
