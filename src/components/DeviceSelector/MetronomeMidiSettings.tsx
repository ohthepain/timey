import { useEffect } from 'react';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { midiService } from '~/lib/MidiService';
import { GoUnmute, GoLock, GoUnlock } from 'react-icons/go';

export default function MetronomeMidiSettings() {
  const {
    metronomeNoteNumber,
    setMetronomeNoteNumber,
    metronomeVelocity,
    setMetronomeVelocity,
    metronomeDownbeatNoteNumber,
    setMetronomeDownbeatNoteNumber,
    isDownbeatLocked,
    setIsDownbeatLocked,
    isUpbeatLocked,
    setIsUpbeatLocked,
    metronomeUpbeatNoteNumber,
    setMetronomeUpbeatNoteNumber,
  } = useMidiSettingsStore();

  // Sync downbeat/upbeat to note number when locked or when note changes
  useEffect(() => {
    if (isDownbeatLocked) {
      setMetronomeDownbeatNoteNumber(metronomeNoteNumber);
    }
    if (isUpbeatLocked) {
      setMetronomeUpbeatNoteNumber(metronomeNoteNumber);
    }
  }, [metronomeNoteNumber, isDownbeatLocked, isUpbeatLocked]);

  return (
    <div className="flex flex-col items-center">
      <div className="text-2xl font-bold text-center">Metronome MIDI Settings</div>
      <div>Select MIDI notes for the metronome.</div> <div>Tap to test!</div>
      <div className="grid grid-cols-[32px_1fr_1fr] gap-x-4 gap-y-2 mt-4 w-full max-w-md">
        {/* Note row */}
        <div />
        <div
          className="font-semibold text-right pr-2 flex items-center group cursor-pointer select-none"
          onClick={() => midiService.playNote(metronomeNoteNumber, metronomeVelocity)}
        >
          Note:
          <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <GoUnmute size={16} />
          </span>
        </div>
        <input
          className="col-span-1"
          type="number"
          value={metronomeNoteNumber}
          onChange={(e) => {
            const value = parseInt(e.target.value);
            setMetronomeNoteNumber(value);
            midiService.playNote(value, metronomeVelocity);
          }}
        />

        {/* Downbeat row */}
        <button
          type="button"
          className={`px-2 py-1 font-bold`}
          onClick={() => {
            const newLocked = !isDownbeatLocked;
            setIsDownbeatLocked(newLocked);
            if (newLocked) {
              setMetronomeDownbeatNoteNumber(metronomeNoteNumber);
              midiService.playNote(metronomeNoteNumber, metronomeVelocity);
            }
          }}
        >
          {isDownbeatLocked ? <GoLock size={18} /> : <GoUnlock size={18} />}
        </button>
        <div
          className="font-semibold text-right pr-2 flex items-center group cursor-pointer select-none"
          onClick={() => midiService.playNote(metronomeDownbeatNoteNumber, metronomeVelocity)}
        >
          Downbeat:
          <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <GoUnmute size={16} />
          </span>
        </div>
        <input
          className="col-span-1"
          type="number"
          value={metronomeDownbeatNoteNumber}
          disabled={isDownbeatLocked}
          onChange={(e) => {
            const value = parseInt(e.target.value);
            setMetronomeDownbeatNoteNumber(value);
            midiService.playNote(value, metronomeVelocity);
          }}
        />

        {/* Upbeat row */}
        <button
          type="button"
          className={`px-2 py-1 font-bold`}
          onClick={() => {
            const newLocked = !isUpbeatLocked;
            setIsUpbeatLocked(newLocked);
            if (newLocked) {
              setMetronomeUpbeatNoteNumber(metronomeNoteNumber);
              midiService.playNote(metronomeNoteNumber, metronomeVelocity);
            }
          }}
        >
          {isUpbeatLocked ? <GoLock size={18} /> : <GoUnlock size={18} />}
        </button>
        <div
          className="font-semibold text-right pr-2 flex items-center group cursor-pointer select-none"
          onClick={() => midiService.playNote(metronomeUpbeatNoteNumber, metronomeVelocity)}
        >
          Upbeat:
          <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <GoUnmute size={16} />
          </span>
        </div>
        <input
          className="col-span-1"
          type="number"
          value={metronomeUpbeatNoteNumber}
          disabled={isUpbeatLocked}
          onChange={(e) => {
            const value = parseInt(e.target.value);
            setMetronomeUpbeatNoteNumber(value);
            midiService.playNote(value, metronomeVelocity);
          }}
        />

        {/* Velocity row */}
        <div />
        <div
          className="font-semibold text-right pr-2 flex items-center group cursor-pointer select-none"
          onClick={() => midiService.playNote(metronomeNoteNumber, metronomeVelocity)}
        >
          Velocity:
          <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <GoUnmute size={16} />
          </span>
        </div>
        <input
          className="col-span-1"
          type="number"
          value={metronomeVelocity}
          onChange={(e) => {
            const value = parseInt(e.target.value);
            setMetronomeVelocity(value);
            midiService.playNote(metronomeNoteNumber, value);
          }}
        />
      </div>
    </div>
  );
}
