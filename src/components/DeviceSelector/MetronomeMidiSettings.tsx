import { useMidiSettingsStore } from '~/state/MidiSettingsStore';

export default function MetronomeMidiSettings() {
  const {
    metronomeNoteNumber,
    setMetronomeNoteNumber,
    metronomeVelocity,
    setMetronomeVelocity,
    metronomeDownbeatNoteNumber,
    setMetronomeDownbeatNoteNumber,
    metronomeUpbeatNoteNumber,
    setMetronomeUpbeatNoteNumber,
  } = useMidiSettingsStore();

  return (
    <div className="flex flex-wrap input-group gap-x-4 overflow-auto flex-auto">
      <div className="flex flex-row">
        Note:
        <input
          type="number"
          value={metronomeNoteNumber}
          onChange={(e) => setMetronomeNoteNumber(parseInt(e.target.value))}
        />
      </div>
      <div className="flex flex-row">
        Downbeat:
        <input
          type="number"
          value={metronomeDownbeatNoteNumber}
          onChange={(e) => setMetronomeDownbeatNoteNumber(parseInt(e.target.value))}
        />
      </div>
      <div className="flex flex-row">
        Upbeat:
        <input
          type="number"
          value={metronomeUpbeatNoteNumber}
          onChange={(e) => setMetronomeUpbeatNoteNumber(parseInt(e.target.value))}
        />
      </div>
      <div className="flex flex-row">
        Velocity:
        <input
          type="number"
          value={metronomeVelocity}
          onChange={(e) => setMetronomeVelocity(parseInt(e.target.value))}
        />
      </div>
    </div>
  );
}
