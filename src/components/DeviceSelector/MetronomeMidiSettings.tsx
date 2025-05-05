import { useEffect } from 'react';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { midiService } from '~/lib/MidiService';
import { GoUnmute, GoLock, GoUnlock } from 'react-icons/go';
import { FaChevronUp, FaChevronDown } from 'react-icons/fa';
import { usePreferencesStore } from '~/state/PreferencesStore';

// General MIDI drum note numbers and names
const DRUM_NOTES = [
  { number: 35, name: 'Acoustic Bass Drum' },
  { number: 36, name: 'Bass Drum 1' },
  { number: 37, name: 'Side Stick' },
  { number: 38, name: 'Acoustic Snare' },
  { number: 39, name: 'Hand Clap' },
  { number: 40, name: 'Electric Snare' },
  { number: 41, name: 'Low Floor Tom' },
  { number: 42, name: 'Closed Hi-Hat' },
  { number: 43, name: 'High Floor Tom' },
  { number: 44, name: 'Pedal Hi-Hat' },
  { number: 45, name: 'Low Tom' },
  { number: 46, name: 'Open Hi-Hat' },
  { number: 47, name: 'Low-Mid Tom' },
  { number: 48, name: 'Hi-Mid Tom' },
  { number: 49, name: 'Crash Cymbal 1' },
  { number: 50, name: 'High Tom' },
  { number: 51, name: 'Ride Cymbal 1' },
  { number: 52, name: 'Chinese Cymbal' },
  { number: 53, name: 'Ride Bell' },
  { number: 54, name: 'Tambourine' },
  { number: 55, name: 'Splash Cymbal' },
  { number: 56, name: 'Cowbell' },
  { number: 57, name: 'Crash Cymbal 2' },
  { number: 58, name: 'Vibraslap' },
  { number: 59, name: 'Ride Cymbal 2' },
  { number: 60, name: 'Hi Bongo' },
  { number: 61, name: 'Low Bongo' },
  { number: 62, name: 'Mute Hi Conga' },
  { number: 63, name: 'Open Hi Conga' },
  { number: 64, name: 'Low Conga' },
  { number: 65, name: 'High Timbale' },
  { number: 66, name: 'Low Timbale' },
  { number: 67, name: 'High Agogo' },
  { number: 68, name: 'Low Agogo' },
  { number: 69, name: 'Cabasa' },
  { number: 70, name: 'Maracas' },
  { number: 71, name: 'Short Whistle' },
  { number: 72, name: 'Long Whistle' },
  { number: 73, name: 'Short Guiro' },
  { number: 74, name: 'Long Guiro' },
  { number: 75, name: 'Claves' },
  { number: 76, name: 'Hi Wood Block' },
  { number: 77, name: 'Low Wood Block' },
  { number: 78, name: 'Mute Cuica' },
  { number: 79, name: 'Open Cuica' },
  { number: 80, name: 'Mute Triangle' },
  { number: 81, name: 'Open Triangle' },
];

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

  const { useFakeMidiClock, setUseFakeMidiClock, fakeMidiClockTimerResolution, setFakeMidiClockTimerResolution } =
    usePreferencesStore();

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
    <div className="flex flex-col items-center p-4">
      <div className="text-2xl font-bold text-center">Metronome MIDI Settings</div>
      <div>Select MIDI notes for the metronome.</div> <div>Tap to test!</div>
      <div className="grid grid-cols-[32px_1fr_1fr] gap-x-4 gap-y-2 mt-12 w-full max-w-md">
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
        <div className="flex items-center col-span-1">
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginRight: 2 }}
            aria-label="Previous note"
            onClick={() => {
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeNoteNumber);
              if (idx > 0) {
                const value = DRUM_NOTES[idx - 1].number;
                setMetronomeNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronUp size={12} />
          </button>
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginLeft: 2 }}
            aria-label="Next note"
            onClick={() => {
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeNoteNumber);
              if (idx < DRUM_NOTES.length - 1) {
                const value = DRUM_NOTES[idx + 1].number;
                setMetronomeNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronDown size={12} />
          </button>
          <select
            className="mx-1 flex-1"
            value={metronomeNoteNumber}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              setMetronomeNoteNumber(value);
              midiService.playNote(value, metronomeVelocity);
            }}
          >
            {DRUM_NOTES.map((note) => (
              <option key={note.number} value={note.number}>
                {note.number} – {note.name}
              </option>
            ))}
          </select>
        </div>

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
        <div className="flex items-center col-span-1">
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginRight: 2 }}
            aria-label="Previous downbeat note"
            disabled={isDownbeatLocked}
            onClick={() => {
              if (isDownbeatLocked) return;
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeDownbeatNoteNumber);
              if (idx > 0) {
                const value = DRUM_NOTES[idx - 1].number;
                setMetronomeDownbeatNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronUp size={12} />
          </button>
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginLeft: 2 }}
            aria-label="Next downbeat note"
            disabled={isDownbeatLocked}
            onClick={() => {
              if (isDownbeatLocked) return;
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeDownbeatNoteNumber);
              if (idx < DRUM_NOTES.length - 1) {
                const value = DRUM_NOTES[idx + 1].number;
                setMetronomeDownbeatNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronDown size={12} />
          </button>
          <select
            className="mx-1 flex-1"
            value={metronomeDownbeatNoteNumber}
            disabled={isDownbeatLocked}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              setMetronomeDownbeatNoteNumber(value);
              midiService.playNote(value, metronomeVelocity);
            }}
          >
            {DRUM_NOTES.map((note) => (
              <option key={note.number} value={note.number}>
                {note.number} – {note.name}
              </option>
            ))}
          </select>
        </div>

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
        <div className="flex items-center col-span-1">
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginRight: 2 }}
            aria-label="Previous upbeat note"
            disabled={isUpbeatLocked}
            onClick={() => {
              if (isUpbeatLocked) return;
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeUpbeatNoteNumber);
              if (idx > 0) {
                const value = DRUM_NOTES[idx - 1].number;
                setMetronomeUpbeatNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronUp size={12} />
          </button>
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ padding: 0, marginLeft: 2 }}
            aria-label="Next upbeat note"
            disabled={isUpbeatLocked}
            onClick={() => {
              if (isUpbeatLocked) return;
              const idx = DRUM_NOTES.findIndex((n) => n.number === metronomeUpbeatNoteNumber);
              if (idx < DRUM_NOTES.length - 1) {
                const value = DRUM_NOTES[idx + 1].number;
                setMetronomeUpbeatNoteNumber(value);
                midiService.playNote(value, metronomeVelocity);
              }
            }}
          >
            <FaChevronDown size={12} />
          </button>
          <select
            className="mx-1 flex-1"
            value={metronomeUpbeatNoteNumber}
            disabled={isUpbeatLocked}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              setMetronomeUpbeatNoteNumber(value);
              midiService.playNote(value, metronomeVelocity);
            }}
          >
            {DRUM_NOTES.map((note) => (
              <option key={note.number} value={note.number}>
                {note.number} – {note.name}
              </option>
            ))}
          </select>
        </div>

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
      {/* Fake MIDI Clock toggle */}
      <div className="mx-8 mt-8 w-full max-w-md flex items-center justify-between gap-4">
        <label htmlFor="fake-midi-clock-toggle" className="font-semibold">
          Use Fake MIDI Clock
        </label>
        <input
          id="fake-midi-clock-toggle"
          type="checkbox"
          checked={useFakeMidiClock}
          onChange={(e) => setUseFakeMidiClock(e.target.checked)}
          className="h-5 w-5 accent-blue-500"
        />
      </div>
      {/* Fake MIDI Clock Timer Resolution Editor */}
      <div className="mx-8 mt-2 w-full max-w-md flex items-center justify-between gap-4">
        <label
          htmlFor="fake-midi-clock-timer-resolution"
          className={`font-semibold ${!useFakeMidiClock ? 'text-gray-400' : ''}`}
        >
          Fake MIDI Clock Timer Resolution
        </label>
        <select
          id="fake-midi-clock-timer-resolution"
          className="border rounded px-2 py-1 w-24 text-right"
          value={fakeMidiClockTimerResolution}
          onChange={(e) => setFakeMidiClockTimerResolution(Number(e.target.value))}
          disabled={!useFakeMidiClock}
        >
          {[1, 2, 4, 8, 16, 32, 64, 128].map((val) => (
            <option key={val} value={val}>
              {val}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
