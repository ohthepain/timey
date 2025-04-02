import { createFileRoute } from '@tanstack/react-router';
import { ScoreViewer } from '~/components/ScoreViewer';
import { ScoreView } from '~/components/ScoreView';
// import { PercussionScore } from '~/components/PercussionScore'
import { BeatView } from '~/components/BeatView';
import { useTempoService } from '~/lib/MidiSync/UseTempoService';
import { Transport } from '~/components/Transport';
import { useScoreStore } from '~/state/ScoreStore';

export const loader = async () => {
  if (!useScoreStore.getState().beats['basic']) {
    console.log('Loading beats...');
    const hihatStr = 'h,h,h,h,h,h,h,h';
    const kickStr = 'k,,,,k,,,';
    const snareStr = ',,s,,,,s,';
    const kickStr1 = 'k,kk,,,k,xkk,xk,';
    const snareStr1 = ',,s,xs,xss,s,,xs';

    const beatStrings = [
      [hihatStr, hihatStr],
      [kickStr, kickStr1],
      [snareStr, snareStr1],
    ];

    const addBeat = useScoreStore.getState().addBeat;
    addBeat('basic', beatStrings);
  } else {
    console.log('Beat already loaded');
  }
};

export const Route = createFileRoute('/sequence/')({
  loader: loader,
  component: SequenceIndexComponent,
});

console.log('zequence index Route loaded');

function SequenceIndexComponent() {
  return (
    <div>
      <Transport />
      <div id="scoreview" className="h-full w-full border-2 border-purple-700">
        <ScoreView />
      </div>
      <div className="bg-green-200 w-full h-2"></div>
    </div>
  );
}
