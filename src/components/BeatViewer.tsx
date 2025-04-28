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
import { copyBeatServerFn, deleteBeatServerFn } from '~/services/beatService.server';
import { ScoreView } from '~/components/ScoreView2';
import { Transport } from './Transport';
import { beatPlayer } from '~/lib/BeatPlayer';
import { beatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import TempoService from '~/lib/MidiSync/TempoService';
import { TempoLadder } from './TempoLadder';

interface BeatViewerProps {
  beat: Beat;
  module: Module;
  beatProgress: BeatProgressView | undefined;
}

export function BeatViewer({ beat, module, beatProgress }: BeatViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(beat.name);
  const { currentBeat } = useNavigationStore();

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
              <div className="flex justify-end">
                <button
                  onClick={handleEditBeat}
                  className="h-8 text-green-500 hover:text-green-700 text-xs px-1 mx-1 border border-green-500 rounded my-1.5"
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  onClick={handleCopyBeat}
                  className="h-8 text-blue-500 hover:text-blue-700 text-xs px-1 mx-1 border border-blue-500 rounded my-1.5"
                  title="Copy"
                >
                  Copy
                </button>
                <button
                  onClick={async () => {
                    handleDeleteBeat(beat.id!);
                    router.invalidate();
                  }}
                  className="h-8 text-red-500 hover:text-red-700 text-xs px-1 mx-1 border border-red-500 rounded my-1.5"
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
