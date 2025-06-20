import { useEffect, useState, useMemo } from 'react';
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
import { fetchUserPerformancesForBeat } from '~/services/performanceService.server';
import { Speedometer } from './Speedometer';
import { TempoService } from '~/lib/TempoService';
import { kMaxWindowSkillLevel } from '~/lib/PerformanceFeedback';

const xboxStyle =
  'text-amber-800 px-2 py-1 w-16 rounded bg-amber-200 border-amber-700 border-2 rounded-e-md text-sm text-center';
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
  const [tempoFeedback, setTempoFeedback] = useState<any>(null);
  const [skillLevel, setSkillLevel] = useState(kMaxWindowSkillLevel);
  const [measuredBpm, setMeasuredBpm] = useState(0);
  const [bgColor, setBgColor] = useState<string>('bg-white');
  const [gradeMinTempo, setGradeMinTempo] = useState(0);
  const [gradeMaxTempo, setGradeMaxTempo] = useState(240);
  const { currentBeat, cachePerformance } = useNavigationStore();
  const { enableAdmin } = usePersistedStore();
  const possibleTempos = [0, 1, 2, 3, 4, 5];

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

  const beatRecorder_tempoFeedback = (tempoFeedback: any) => {
    setTempoFeedback(tempoFeedback);
    if (tempoFeedback.windowSkillLevel != skillLevel) {
      setSkillLevel(tempoFeedback.windowSkillLevel);
    }
    // Set anything we want to react to
    setMeasuredBpm(tempoFeedback.bpm);
    const bgColor = getSkillLevelColor(tempoFeedback.windowSkillLevel);
    setBgColor(bgColor);

    const nearestPowerOf2 = Math.pow(2, tempoFeedback.windowSkillLevel);
    const gradeMinTempo = tempoService.bpm - nearestPowerOf2 * 2;
    const gradeMaxTempo = tempoService.bpm + nearestPowerOf2 * 2;
    setGradeMinTempo(gradeMinTempo);
    setGradeMaxTempo(gradeMaxTempo);
  };

  useEffect(() => {
    console.log('BeatViewer: useEffect: bgColor', bgColor);
  }, [bgColor]);

  useEffect(() => {
    BeatRecorder.getInstance().on('tempoFeedback', beatRecorder_tempoFeedback);

    return () => {
      BeatRecorder.getInstance().off('tempoFeedback', beatRecorder_tempoFeedback);
    };
  }, []);

  useEffect(() => {
    const fetchBeatProgress = async () => {
      if (beat.id) {
        const beatId = beat.id;
        const performances: Performance[] = (await fetchUserPerformancesForBeat({ data: { beatId } })).map(
          (performanceData) => new Performance(performanceData)
        );
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
                  min={gradeMinTempo}
                  max={gradeMaxTempo}
                  value={tempoFeedback?.bpm || 120}
                  instantValue={tempoFeedback?.lastNoteEffectiveTempo || 120}
                  bgColor={bgColor}
                />
                <div className="flex flex-row items-center justify-between w-full">
                  <div className={boxStyle}>{gradeMinTempo || '...'}</div>
                  <div className={boxStyle}>{tempoFeedback?.bpm ? tempoFeedback?.bpm.toFixed(1) : '...'}</div>
                  <div className={boxStyle}>{gradeMaxTempo || '...'}</div>
                </div>
              </div>
              <div className="flex-shrink-0">
                <Ladder values={possibleTempos} currentValue={skillLevel} />
              </div>
            </div>
          </div>
        )}
        <div
          onClick={async () => {
            await startBeatServerFn({ data: { beatId: beat.id } });
            beatPlayer.setBeat(beat);
            BeatRecorder.getInstance().setBeat(beat);
          }}
        >
          <div className="flex flex-row items-center mx-4">
            <Ladder
              values={[140, 120, 100, 90]}
              currentValue={beatProgress?.bestTempo || 0}
              onSelectValue={async (tempo) => {
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
