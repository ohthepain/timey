import { BeatRecorder } from '~/lib/BeatRecorder';
import { privatePractice } from '~/state/privatePractice';
import { useNavigationStore } from '~/state/NavigationStore';
import { deletePerformancesByBeatIdAndUserId } from '~/services/performanceService';
import { openReplayCsvPicker } from '~/lib/transportRecording';

type TransportSecondaryButtonsProps = {
  isRunning: boolean;
  practiceUserId: string | null;
  beatId?: string;
  performanceCount: number;
  onFailure: (message: string) => void;
  onClearFailure: () => void;
};

export function TransportSecondaryButtons({
  isRunning,
  practiceUserId,
  beatId,
  performanceCount,
  onFailure,
  onClearFailure,
}: TransportSecondaryButtonsProps) {
  const beatRecorder = BeatRecorder.getInstance();

  if (isRunning) return null;

  const savePerformance = async () => {
    try {
      await beatRecorder.savePerformance();
      onClearFailure();
    } catch {
      onFailure('Unable to save recording. Sign in or retry.');
    }
  };

  const deletePerformances = async () => {
    if (!beatId || !practiceUserId) return;
    try {
      const deleted = await privatePractice(() => deletePerformancesByBeatIdAndUserId({ data: { beatId } }));
      if (deleted) {
        useNavigationStore.getState().clearPerformancesForBeatId(beatId);
        useNavigationStore.getState().setCurrentPerformance(null);
      }
      onClearFailure();
    } catch {
      onFailure('Unable to delete recordings. Sign in or retry.');
    }
  };

  return (
    <>
      {practiceUserId && (
        <button
          className="text-blue-700 px-2 m-1 rounded hover:bg-blue-200 border-blue-600 border-2 rounded-e-md text-sm"
          onClick={savePerformance}
        >
          Save
        </button>
      )}
      {beatId && (
        <button
          className="text-orange-700 px-2 m-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
          onClick={openReplayCsvPicker}
        >
          {`Replay (${performanceCount})`}
        </button>
      )}
      {practiceUserId && beatId && (
        <button
          className="text-orange-700 px-2 m-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
          onClick={deletePerformances}
        >
          {`Delete ${performanceCount} recordings`}
        </button>
      )}
    </>
  );
}
