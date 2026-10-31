import { useEffect, useState } from 'react';
import { BeatRecorder } from '~/lib/BeatRecorder';
import { BeatNoteFeedback } from '~/lib/PerformanceFeedback';
import { Speedometer } from './Speedometer';
import { Ladder } from './Ladder';

function feedbackGrade() {
  const last8 = BeatRecorder.getInstance().performanceFeedback.beatNoteFeedback.slice(-8);
  const maxError = Math.max(0, ...last8.map((feedback) => Math.abs(feedback.timingDifferenceMs ?? 0)));
  const grade = Math.max(1, Math.ceil(Math.log2(maxError / 2)));
  return Number.isFinite(grade) ? grade : 1;
}

export function PracticeFeedback({ active }: { active: boolean }) {
  const [difference, setDifference] = useState(0);
  const [grade, setGrade] = useState(1);
  const [errorMargin, setErrorMargin] = useState(2);
  useEffect(() => {
    const recorder = BeatRecorder.getInstance();
    const receive = (feedback: BeatNoteFeedback) => {
      setDifference(feedback.timingDifferenceMs || 0);
      const nextGrade = feedbackGrade();
      setGrade(nextGrade);
      setErrorMargin(Math.pow(2, nextGrade + 1));
    };
    recorder.on('beatNoteFeedback', receive);
    return () => {
      recorder.off('beatNoteFeedback', receive);
    };
  }, []);
  if (!active) return null;
  const boxStyle = 'text-amber-800 px-2 py-1 w-16 text-sm text-center';
  return (
    <div className="w-full shadow-sm bg-white flex">
      <div className="flex-1">
        <Speedometer
          min={-errorMargin}
          max={errorMargin}
          value={difference}
          instantValue={difference}
          bgColor="bg-white"
        />
        <div className="flex flex-row items-center justify-between w-full">
          <div className={boxStyle}>{-errorMargin}</div>
          <div className={boxStyle}>0</div>
          <div className={boxStyle}>{errorMargin}</div>
        </div>
      </div>
      <div className="flex-shrink-0">
        <Ladder values={[1, 2, 3, 4, 5]} currentValue={grade} />
      </div>
    </div>
  );
}
