import { useState } from 'react';
import { Module } from '~/types/Module';
import { BeatProgressView } from '~/services/userProgressServerService.server';
import { BeatViewer } from './BeatViewer';
import { Beat } from '~/types/Beat';

export interface ModuleProps {
  module: Module;
  beatProgress: BeatProgressView[];
}

export const ModuleViewer = ({ module, beatProgress }: ModuleProps) => {
  const [beatProgressMap] = useState<Map<string, BeatProgressView>>(() => {
    const map = new Map<string, BeatProgressView>();
    beatProgress.forEach((beat) => {
      map.set(beat.beatId, beat);
    });
    return map;
  });

  return (
    <div className="module-page p-4">
      <h1 className="text-2xl font-bold mb-4">Module: {module.title}</h1>
      <p className="mb-2">Description: {module.description || 'No description provided.'}</p>
      <p className="mb-2">Index: {module.index}</p>
      <p className="mb-2">Author ID: {module.authorId}</p>
      <div className="mt-4">
        {module.beats && module.beats.length > 0 ? (
          <ul className="pl-4">
            {module.beats.map((beat: Beat) => (
              <li key={beat.id} className="">
                <BeatViewer
                  beat={beat}
                  beatProgress={beat.id ? beatProgressMap.get(beat.id) : undefined}
                  module={module}
                />
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
