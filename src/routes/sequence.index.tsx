import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ScoreView } from '~/components/ScoreView2';
import { Transport } from '~/components/Transport';
import { Beat } from '~/types/Beat';
import { getBeatByNameServerFn } from '~/services/beatService.server';

export const Route = createFileRoute('/sequence/')({
  component: SequenceIndexComponent,
});

console.log('zequence index Route loaded');

function SequenceIndexComponent() {
  const [beat, setBeat] = useState<Beat | undefined>(undefined);

  useEffect(() => {
    (async () => {
      const beat: Beat | null = await getBeatByNameServerFn({ data: { name: 'Basic Beat2' } });
      if (beat) setBeat(beat);
    })();
  }, []);

  if (!beat) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <Transport />
      <div id="scoreview" className="h-full w-full border-2 border-purple-700">
        <ScoreView beat={beat} />
      </div>
      <div className="bg-green-200 w-full h-2"></div>
    </div>
  );
}
