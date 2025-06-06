import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ScoreView } from '~/components/ScoreView';
import { Transport } from '~/components/Transport';
import { Beat } from '~/types/Beat';
import { getBeatByNameServerFn } from '~/services/beatService.server';
import MidiSelector from '~/components/DeviceSelector/MidiSelector';
import MetronomeMidiSettings from '~/components/DeviceSelector/MetronomeMidiSettings';

export const Route = createFileRoute('/sequence/')({
  component: SequenceIndexComponent,
});

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
      <div className="flex flex-row justify-between items-center">
        <div className="mx-8 my-2 p-2">
          <MetronomeMidiSettings />
        </div>
      </div>
      <Transport beat={beat} />
      <div id="scoreview" className="h-full w-full border-2 border-purple-700">
        <ScoreView beat={beat} />
      </div>
      <div className="bg-green-200 w-full h-2"></div>
    </div>
  );
}
