import { useState } from 'react';
import { Beat } from '~/types/Beat';
import { Performance } from '~/types/Performance';
import { Module } from '~/types/Module';
import { BeatEditor } from './BeatEditor';
import { BeatProgressView } from '~/services/userProgressServerService.server';
import { useRouter } from '@tanstack/react-router';
import { CopyBeat } from './CopyBeat';
import { deleteBeatServerFn } from '~/services/beatService.server';
import { ScoreView } from '~/components/ScoreView';
import { Transport } from './Transport';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';
import { Ladder } from './Ladder';
import { useBeatPractice } from './useBeatPractice';
import { PracticeFeedback } from './PracticeFeedback';

interface BeatViewerProps {
  beat: Beat;
  module: Module;
  beatProgress: BeatProgressView | undefined;
  onSaved: () => void;
}

export function BeatViewer({ beat, module, beatProgress, onSaved }: BeatViewerProps) {
  const { currentBeat } = useNavigationStore();
  const { practiceError, selectBeat, passTempo } = useBeatPractice(beat);

  const editing = useBeatEditing(beat);
  return (
    <div>
      {practiceError && <p role="alert">{practiceError}</p>}
      <div className="flex flex-col justify-between items-center">
        <BeatHeading beat={beat} editing={editing} />
        <PracticeFeedback active={currentBeat === beat} />
        <div onClick={selectBeat}>
          <div className="flex flex-row items-center mx-4">
            <Ladder values={[140, 120, 100, 90]} currentValue={bestTempo(beatProgress)} onSelectValue={passTempo} />
            <ScoreView beat={beat} />
          </div>
        </div>
      </div>
      {editing.isEditing && (
        <BeatEditor
          beat={beat}
          module={module}
          onSave={() => {
            editing.setIsEditing(false);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function bestTempo(progress: BeatProgressView | undefined) {
  return progress?.bestTempo || 0;
}

function useBeatEditing(beat: Beat) {
  const [isEditing, setIsEditing] = useState(false);
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

  const handleEditBeat = async () => {
    setIsEditing(!isEditing);

    if (beat.id) {
      const performances = useNavigationStore.getState().getPerformancesForBeatId(beat.id);
      const performance: Performance | null = performances && performances.length > 0 ? performances[0] : null;
      console.log('BeatViewer: setCurrentPerformance: ', performance);
      useNavigationStore.getState().setCurrentPerformance(performance);
    } else {
      console.log('BeatViewer: setCurrentPerformance: to null');
      useNavigationStore.getState().setCurrentPerformance(null);
    }
  };

  return { isEditing, setIsEditing, handleDeleteBeat, handleEditBeat, router };
}

function BeatHeading({ beat, editing }: { beat: Beat; editing: ReturnType<typeof useBeatEditing> }) {
  const { currentBeat } = useNavigationStore();
  const { enableAdmin } = usePersistedStore();
  const { handleDeleteBeat, router } = editing;
  return (
    <div className="flex flex-row w-full">
      <div className="flex-col items-center w-full">
        <div className="flex flex-row items-center ">
          <div className="font-semibold text-3xl mx-4 ">{beat.name}</div>
          {currentBeat === beat && <Transport />}
          <CopyBeat beat={beat} />
          <BeatEditControl beat={beat} editing={editing} />
          {enableAdmin && (
            <div className="flex justify-end space-between">
              <button
                onClick={async () => {
                  handleDeleteBeat(beat.id!);
                  router.invalidate();
                }}
                className="text-red-700 px-2 mx-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
                title="Delete"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BeatEditControl({ beat, editing }: { beat: Beat; editing: ReturnType<typeof useBeatEditing> }) {
  const userId = useNavigationStore((state) => state.practiceUserId);
  if (!userId)
    return <a href={`/auth/login?returnTo=${encodeURIComponent('/module/' + beat.moduleId)}`}>Sign in to edit</a>;
  if (userId !== beat.authorId) return null;
  return (
    <button
      onClick={editing.handleEditBeat}
      className="text-green-700 px-2 mx-1 rounded hover:bg-green-200 border-green-600 border-2 rounded-e-md text-sm"
      title="Edit"
    >
      {editing.isEditing ? 'Cancel' : 'Edit'}
    </button>
  );
}
