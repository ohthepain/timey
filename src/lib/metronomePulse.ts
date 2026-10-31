import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { useNavigationStore } from '~/state/NavigationStore';
import type { TempoService } from '~/lib/TempoService';

export function metronomeTickNote(tempoService: TempoService, ticks: number): number | null {
  const midiSettings = useMidiSettingsStore.getState();
  const shouldTick =
    tempoService.isRunning &&
    useNavigationStore.getState().isMetronomeOn &&
    ticks % tempoService.ppqn === 0 &&
    Boolean(midiSettings.midiOutputDeviceId);
  return shouldTick ? midiSettings.metronomeNoteNumber : null;
}
