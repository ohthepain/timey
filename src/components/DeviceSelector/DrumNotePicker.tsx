import { FaChevronDown, FaChevronUp } from 'react-icons/fa';

type DrumNoteOption = { number: number; name: string };

type DrumNotePickerProps = {
  notes: DrumNoteOption[];
  value: number;
  disabled?: boolean;
  velocity: number;
  previousLabel: string;
  nextLabel: string;
  onChange: (noteNumber: number) => void;
  onPreview: (noteNumber: number, velocity: number) => void;
};

export function DrumNotePicker({
  notes,
  value,
  disabled = false,
  velocity,
  previousLabel,
  nextLabel,
  onChange,
  onPreview,
}: DrumNotePickerProps) {
  const setNote = (noteNumber: number) => {
    onChange(noteNumber);
    onPreview(noteNumber, velocity);
  };

  return (
    <div className="flex items-center col-span-1">
      <button
        type="button"
        className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ padding: 0, marginRight: 2 }}
        aria-label={previousLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          const idx = notes.findIndex((n) => n.number === value);
          if (idx > 0) setNote(notes[idx - 1].number);
        }}
      >
        <FaChevronUp size={12} />
      </button>
      <button
        type="button"
        className="h-6 w-6 flex items-center justify-center text-gray-500 hover:text-black border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ padding: 0, marginLeft: 2 }}
        aria-label={nextLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          const idx = notes.findIndex((n) => n.number === value);
          if (idx < notes.length - 1) setNote(notes[idx + 1].number);
        }}
      >
        <FaChevronDown size={12} />
      </button>
      <select
        className="mx-1 flex-1"
        value={value}
        disabled={disabled}
        onChange={(e) => setNote(parseInt(e.target.value))}
      >
        {notes.map((note) => (
          <option key={note.number} value={note.number}>
            {note.number} – {note.name}
          </option>
        ))}
      </select>
    </div>
  );
}
