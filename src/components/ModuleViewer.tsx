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
    <div className="module-page flex flex-row items-start">
      <div className="flex-1">
        <h1 className="text-3xl font-bold mb-4 align-middle text-center">{module.title}</h1>
        <div className="mt-4">
          {module.beats && module.beats.length > 0 ? (
            <ul className="">
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
    </div>
  );
};
