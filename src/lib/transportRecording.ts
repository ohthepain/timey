import { EventRecorderService } from '~/lib/EventRecorderService';
import { TempoService } from '~/lib/TempoService';
import { BeatRecorder } from '~/lib/BeatRecorder';

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function stopTransport(devMode: boolean) {
  const tempoService = TempoService.getInstance();
  const wasRecording = tempoService.isRecording;
  tempoService.stop();

  if (!devMode || !wasRecording) return;

  const eventRecorder = EventRecorderService.getInstance();
  downloadCsv('live.csv', eventRecorder.toCsv());
  eventRecorder.clear();
}

export function openReplayCsvPicker() {
  const tempoService = TempoService.getInstance();
  const beatRecorder = BeatRecorder.getInstance();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const eventRecorder = EventRecorderService.getInstance();
    const reader = new FileReader();
    reader.onload = (event) => {
      if (tempoService.isRunning) {
        alert('Stop practice before replaying.');
        return;
      }
      const content = event.target?.result as string;
      try {
        eventRecorder.loadFromCsvText(content);
        beatRecorder.replay();
      } catch (error) {
        console.error('Replay failed:', error);
        alert('Unable to replay this recording.');
        return;
      }
      const lastDotIndex = file.name.lastIndexOf('.');
      const replayFilename = file.name.slice(0, lastDotIndex) + '-replay' + file.name.slice(lastDotIndex);
      eventRecorder.saveToCsv(replayFilename);
    };
    reader.onerror = () => alert('Unable to read this recording.');
    reader.readAsText(file);
  };
  input.click();
}
