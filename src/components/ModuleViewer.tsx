import { useState } from 'react';
import { Module } from '~/types/Module';
import { BeatProgressView } from '~/services/userProgressServerService.server';
import { BeatViewer } from './BeatViewer';
import { Beat } from '~/types/Beat';
import { BeatEditor } from './BeatEditor';
import { Link } from '@tanstack/react-router';

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

  // Sort beats by index
  const sortedBeats = module.beats ? [...module.beats].sort((a, b) => a.index - b.index) : [];

  return (
    <div className="module-page flex flex-col items-start">
      <div className="flex-1">
        <div className="module-header mb-4 text-center">
          {module.method && (
            <h2 className="font-medium text-gray-500 mb-1 text-xl">
              <Link to="/method/$id" params={{ id: module.method.id }} className="hover:underline">
                {module.method.title}
              </Link>
            </h2>
          )}
          <h1 className="text-3xl font-bold m-4">{module.title}</h1>
        </div>
        <div className="mt-4">
          {sortedBeats.length > 0 ? (
            <div className="space-y-4">
              {sortedBeats.map((beat) => (
                <BeatViewer key={beat.id} beat={beat} module={module} beatProgress={beatProgressMap.get(beat.id!)} />
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No beats yet. Add your first beat!</p>
          )}
        </div>
      </div>
      <div className="bg-gray-400 w-full h-1 m-8" />
      New Beat:
      <BeatEditor beat={new Beat({ name: 'New Beat', moduleId: module.id })} module={module} />
    </div>
  );
};
