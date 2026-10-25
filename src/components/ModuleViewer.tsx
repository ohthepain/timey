import { Module } from '~/types/Module';
import { BeatProgressView } from '~/services/userProgressServerService.server';
import { BeatViewer } from './BeatViewer';
import { useNavigationStore } from '~/state/NavigationStore';
import { BeatEditor } from './BeatEditor';
import { Link } from '@tanstack/react-router';

export interface ModuleProps {
  module: Module;
  beatProgress: BeatProgressView[];
  onCreated: () => void;
}

export const ModuleViewer = ({ module, beatProgress, onCreated }: ModuleProps) => {
  const userId = useNavigationStore((state) => state.practiceUserId);
  const beatProgressMap = new Map(beatProgress.map((progress) => [progress.beatId, progress]));

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
                <BeatViewer
                  key={`${beat.id}:${userId}`}
                  beat={beat}
                  module={module}
                  beatProgress={beatProgressMap.get(beat.id!)}
                  onSaved={onCreated}
                />
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No beats yet. Add your first beat!</p>
          )}
        </div>
      </div>
      <div className="bg-gray-400 w-full h-1 m-8" />
      <BeatCreation module={module} onCreated={onCreated} />
    </div>
  );
};

function BeatCreation({ module, onCreated }: { module: Module; onCreated: () => void }) {
  const userId = useNavigationStore((state) => state.practiceUserId);
  if (!userId)
    return (
      <a
        className="text-indigo-600 underline"
        href={`/auth/login?returnTo=${encodeURIComponent('/module/' + module.id)}`}
      >
        Sign in to create beats
      </a>
    );
  if (module.authorId !== userId) return <p>Only the module author can create beats here.</p>;
  return (
    <section aria-label="New beat">
      <h2>New Beat</h2>
      <BeatEditor key={`${module.id}:${userId}`} beat={null} module={module} onSave={onCreated} />
    </section>
  );
}
