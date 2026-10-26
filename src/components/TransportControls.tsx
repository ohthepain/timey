import { useNavigationStore } from '~/state/NavigationStore';
import { TempoInput } from './TempoInput';
import { Metronome } from './Metronome';
import { TransportPrimaryButtons } from './TransportPrimaryButtons';
import { TransportSecondaryButtons } from './TransportSecondaryButtons';

type TransportControlsProps = {
  isRunning: boolean;
  isRecording: boolean;
  practiceUserId: string | null;
  devMode: boolean;
  onFailure: (message: string) => void;
  onClearFailure: () => void;
  onPlay: () => void;
  onRecord: () => void;
};

export function TransportControls(props: TransportControlsProps) {
  const { currentBeat, getPerformancesForBeatId } = useNavigationStore();
  const beatId = currentBeat?.id;
  const performanceCount = beatId ? getPerformancesForBeatId(beatId).length : 0;

  return (
    <div className="flex">
      <TransportPrimaryButtons
        isRunning={props.isRunning}
        isRecording={props.isRecording}
        devMode={props.devMode}
        onPlay={props.onPlay}
        onRecord={props.onRecord}
      />
      <TransportSecondaryButtons
        isRunning={props.isRunning}
        practiceUserId={props.practiceUserId}
        beatId={beatId}
        performanceCount={performanceCount}
        onFailure={props.onFailure}
        onClearFailure={props.onClearFailure}
      />
      <TempoInput />
      <Metronome beatsPerBar={4} />
    </div>
  );
}
