import { midiService } from '~/lib/MidiService';
import { TempoService } from '~/lib/TempoService';
import { MIDI_CLOCK_LOST, MIDI_CLOCK_PULSE, type MidiClockPulseEvent } from '~/lib/midiClockEvents';
import { midiTransportPolicy } from '~/lib/midiTransportPolicy';
import { SLAVE_TRANSPORT_COMMAND, type SlaveTransportCommand } from '~/lib/slaveTransportCommand';

function applySlaveTransport(tempo: TempoService, command: SlaveTransportCommand) {
  if (command === 'record') tempo.record();
  else if (command === 'stop') tempo.stop();
  else tempo.continue();
}

function applyClockPulse(tempo: TempoService, pulse: MidiClockPulseEvent) {
  midiTransportPolicy().setExternalMidiClock(true, pulse.bpm, pulse.ppqn);
  tempo.stopIntervalTimer();
  tempo.handleMidiClockPulse();
}

function applyClockLost(tempo: TempoService) {
  midiTransportPolicy().setExternalMidiClock(false);
  if (tempo.isPlaying || tempo.isRecording) tempo.startIntervalTimer();
}

export function wireMidiTransportToTempo(tempo: TempoService = TempoService.getInstance()) {
  const onTransport = (command: SlaveTransportCommand) => applySlaveTransport(tempo, command);
  const onPulse = (pulse: MidiClockPulseEvent) => applyClockPulse(tempo, pulse);
  const onLost = () => applyClockLost(tempo);

  midiService.on(SLAVE_TRANSPORT_COMMAND, onTransport);
  midiService.on(MIDI_CLOCK_PULSE, onPulse);
  midiService.on(MIDI_CLOCK_LOST, onLost);

  return () => {
    midiService.off(SLAVE_TRANSPORT_COMMAND, onTransport);
    midiService.off(MIDI_CLOCK_PULSE, onPulse);
    midiService.off(MIDI_CLOCK_LOST, onLost);
  };
}
