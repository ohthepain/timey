import { stopTransport } from '~/lib/transportRecording';

type TransportPrimaryButtonsProps = {
  isRunning: boolean;
  isRecording: boolean;
  devMode: boolean;
  onPlay: () => void;
  onRecord: () => void;
};

export function TransportPrimaryButtons({
  isRunning,
  isRecording,
  devMode,
  onPlay,
  onRecord,
}: TransportPrimaryButtonsProps) {
  return (
    <>
      {isRunning && !isRecording ? (
        <button
          className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
          onClick={() => stopTransport(devMode)}
        >
          Stop
        </button>
      ) : (
        <button
          className="text-green-700 px-2 m-1 rounded hover:bg-red-200 border-green-600 border-2 rounded-e-md text-sm"
          onClick={onPlay}
        >
          Play
        </button>
      )}
      {isRunning && isRecording ? (
        <button
          className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
          onClick={() => stopTransport(devMode)}
        >
          Stop
        </button>
      ) : (
        <button
          className="text-red-700 px-2 m-1 rounded hover:bg-red-200 border-red-600 border-2 rounded-e-md text-sm"
          onClick={onRecord}
        >
          Record
        </button>
      )}
    </>
  );
}
