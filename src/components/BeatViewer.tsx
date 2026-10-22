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
import { ScoreView } from '~/components/ScoreView';
import { Transport } from './Transport';
import { beatPlayer } from '~/lib/BeatPlayer';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { useNavigationStore } from '~/state/NavigationStore';
import { usePersistedStore } from '~/state/PersistedStore';
import { Ladder } from './Ladder';
import { fetchUserPerformancesForBeatServerFn } from '~/services/performanceService.server';
import { Speedometer } from './Speedometer';
import { TempoService } from '~/lib/TempoService';
import { BeatNoteFeedback } from '~/lib/PerformanceFeedback';
import { useKeycloak } from '~/contexts/KeycloakContext';

const boxStyle = 'text-amber-800 px-2 py-1 w-16 text-sm text-center';

interface BeatViewerProps {
  beat: Beat;
  module: Module;
  beatProgress: BeatProgressView | undefined;
}

// Returns the color name for a given belt rank (1 = black, 2 = brown, etc)
function getSkillLevelColor(rank: number): string {
  const beltColors = [
    'bg-gray-600',
    'bg-amber-800',
    'bg-purple-300',
    'bg-blue-300',
    'bg-green',
    'bg-orange-300',
    'bg-yellow-300',
  ];
  if (rank >= 0 && rank < beltColors.length) {
    return beltColors[rank];
  } else {
    return 'bg-white';
  }
}

export function BeatViewer({ beat, module, beatProgress }: BeatViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(beat.name);
  const [beatNoteFeedback, setBeatNoteFeedback] = useState<BeatNoteFeedback | null>(null);
  const [tempoFeedback, setTempoFeedback] = useState<any>(null);
  const [skillLevel, setSkillLevel] = useState(1); // default to 1, not 0
  const [measuredBpm, setMeasuredBpm] = useState(0);
  const [bgColor, setBgColor] = useState<string>('bg-white');
  const [gradeMinTempo, setGradeMinTempo] = useState(0);
  const [gradeMaxTempo, setGradeMaxTempo] = useState(240);
  const [gradeMinError, setGradeMinError] = useState(-2);
  const [gradeMaxError, setGradeMaxError] = useState(2);
  const { currentBeat, cachePerformance } = useNavigationStore();
  const { enableAdmin } = usePersistedStore();
  const possibleTempos = [0, 1, 2, 3, 4, 5];
  const { keycloak } = useKeycloak();

  const tempoService = TempoService.getInstance();

  // Update name when beat changes
  useEffect(() => {
    setName(beat.name);
  }, [beat.name]);

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
      const newBeat = await copyBeatServerFn({ data: { id: beat.id } });
      if (newBeat) {
        // Update the current beat with the new one
        useNavigationStore.getState().setCurrentBeat(new Beat(newBeat));
        // Refresh the router to update the UI
        router.invalidate();
      }
    } catch (error) {
      console.error('Error copying beat:', error);
      alert('Failed to copy beat');
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

  const beatRecorder_beatNoteFeedback = (beatNoteFeedback: BeatNoteFeedback) => {
    console.log('BeatViewer: beatRecorder_beatNoteFeedback: ', beatNoteFeedback.timingDifferenceMs);
    setBeatNoteFeedback(beatNoteFeedback);

    const feedbackArr = BeatRecorder.getInstance().performanceFeedback.beatNoteFeedback;
    const last8 = feedbackArr.slice(-8);
    const maxError = last8.length > 0 ? Math.max(...last8.map((fb) => Math.abs(fb.timingDifferenceMs ?? 0))) : 0;
    // Grade is log2 of max error margin, min 1
    let grade = Math.max(1, Math.ceil(Math.log2(maxError / 2)));
    if (!isFinite(grade) || maxError === 0) grade = 1;
    if (grade !== skillLevel) {
      setSkillLevel(grade);
    }
    // Calculate ms error bounds for the current grade (min grade 1)
    const errorMargin = Math.pow(2, grade + 1);
    setGradeMinError(-errorMargin);
    setGradeMaxError(errorMargin);
  };

  useEffect(() => {
    console.log('BeatViewer: useEffect: bgColor', bgColor);
  }, [bgColor]);

  useEffect(() => {
    BeatRecorder.getInstance().on('beatNoteFeedback', beatRecorder_beatNoteFeedback);

    return () => {
      BeatRecorder.getInstance().off('beatNoteFeedback', beatRecorder_beatNoteFeedback);
    };
  }, []);

  useEffect(() => {
    const fetchBeatProgress = async () => {
      if (beat.id) {
        const beatId = beat.id;
        const token = keycloak?.token;
        if (token) {
          const performances: Performance[] = (
            await fetchUserPerformancesForBeatServerFn({ data: { beatId, token } })
          ).map((performanceData) => new Performance(performanceData));
          for (const performance of performances) {
            cachePerformance(performance);
          }
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
              <div className="font-semibold text-3xl mx-4 ">{name}</div>
              {currentBeat === beat && <Transport />}
              {enableAdmin && (
                <div className="flex justify-end space-between">
                  <button
                    onClick={handleEditBeat}
                    className="text-green-700 px-2 mx-1 rounded hover:bg-green-200 border-green-600 border-2 rounded-e-md text-sm"
                    title="Edit"
                  >
                    {isEditing ? 'Cancel' : 'Edit'}
                  </button>
                  <button
                    onClick={handleCopyBeat}
                    className="text-blue-700 px-2 mx-1 rounded hover:bg-blue-200 border-blue-600 border-2 rounded-e-md text-sm"
                    title="Copy"
                  >
                    Copy
                  </button>
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
        {currentBeat === beat && (
          <div className={'w-full shadow-sm bg-white'}>
            <div className="flex w-full">
              <div className="flex-1">
                <Speedometer
                  min={gradeMinError}
                  max={gradeMaxError}
                  value={beatNoteFeedback?.timingDifferenceMs || 0}
                  instantValue={beatNoteFeedback?.timingDifferenceMs || 0}
                  bgColor={bgColor}
                />
                <div className="flex flex-row items-center justify-between w-full">
                  <div className={boxStyle}>{gradeMinError || '...'}</div>
                  <div className={boxStyle}>0</div>
                  <div className={boxStyle}>{gradeMaxError || '...'}</div>
                </div>
              </div>
              <div className="flex-shrink-0">
                <Ladder values={possibleTempos.filter((g) => g >= 1)} currentValue={skillLevel} />
              </div>
            </div>
          </div>
        )}
        <div
          onClick={async () => {
            if (keycloak?.token && beat.id) {
              await startBeatServerFn({ data: { token: keycloak?.token, beatId: beat.id } });
            }
            beatPlayer.setBeat(beat);
            BeatRecorder.getInstance().setBeat(beat);
          }}
        >
          <div className="flex flex-row items-center mx-4">
            <Ladder
              values={[140, 120, 100, 90]}
              currentValue={beatProgress?.bestTempo || 0}
              onSelectValue={async (tempo) => {
                if (keycloak?.token && beat.id) {
                  await passBeatTempoServerFn({ data: { token: keycloak?.token, beatId: beat.id, tempo: tempo } });
                }
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
