import { useEffect, useState } from 'react';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';
import { Module } from '~/types/Module';
import { BeatEditor } from './BeatEditor';
import {
  BeatProgressView,
  passBeatTempoServerFn,
  startBeatServerFn,
} from '~/services/userProgressServerService.server';
import { useRouter } from '@tanstack/react-router';
import { copyBeatServerFn, deleteBeatServerFn } from '~/services/beatService.server';
import { ScoreView } from '~/components/ScoreView2';
import { Transport } from './Transport';
import { beatPlayer } from '~/lib/BeatPlayer';
import { beatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import { TempoLadder } from './TempoLadder';
import { fetchUserPerformancesForBeat } from '~/services/performanceService.server';

interface BeatViewerProps {
  beat: Beat;
  module: Module;
  beatProgress: BeatProgressView | undefined;
}

export function BeatViewer({ beat, module, beatProgress }: BeatViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(beat.name);
  const [performances, setPerformances] = useState<Performance[]>([]);
  const { currentBeat, cachePerformance } = useNavigationStore();

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

  const handleCopyBeat = async () => {
    try {
      await copyBeatServerFn({ data: { id: beat.id } });
      router.invalidate();
    } catch (error) {
      console.error('Error copying beat:', error);
      alert('Failed to copy beat');
    }
  };

  const handleEditBeat = async () => {
    setIsEditing(!isEditing);
  };

  useEffect(() => {
    const fetchBeatProgress = async () => {
      if (beat.id) {
        const beatId = beat.id;
        const performances: Performance[] = await fetchUserPerformancesForBeat({ data: { beatId } });
        for (const performance of performances) {
          cachePerformance(performance);
        }
      }
    };
    fetchBeatProgress();
  }, [beat.id]);

  return (
    <div>
      <div className="flex flex-col justify-between items-center">
        <div className="flex flex-row w-full">
          <div className="flex-col items-center w-full">
            <div className="flex flex-row items-center ">
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
              {currentBeat === beat && <Transport />}
              <div className="flex justify-end space-between">
                <button
                  onClick={handleEditBeat}
                  className="text-green-700 px-2 m-1 rounded hover:bg-green-200 border-green-600 border-2 rounded-e-md text-sm"
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  onClick={handleCopyBeat}
                  className="text-blue-700 px-2 m-1 rounded hover:bg-blue-200 border-blue-600 border-2 rounded-e-md text-sm"
                  title="Copy"
                >
                  Copy
                </button>
                <button
                  onClick={async () => {
                    handleDeleteBeat(beat.id!);
                    router.invalidate();
                  }}
                  className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
                  title="Delete"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
        <div
          className="w-full"
          onClick={async () => {
            await startBeatServerFn({ data: { beatId: beat.id } });
            beatPlayer.setBeat(beat);
            beatRecorder.setBeat(beat);
          }}
        >
          <div className="flex flex-row items-center">
            <TempoLadder
              tempos={[140, 120, 100, 90]}
              currentTempo={beatProgress?.bestTempo || 0}
              onSelectTempo={async (tempo) => {
                await passBeatTempoServerFn({ data: { beatId: beat.id, tempo: tempo } });
              }}
            />
            <ScoreView beat={beat} />
          </div>
        </div>
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
