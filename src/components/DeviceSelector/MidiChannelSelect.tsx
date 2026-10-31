import type { ChangeEvent } from 'react';

const MIDI_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

type MidiChannelSelectProps = {
  value: number | '';
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onRefreshDevices?: () => void | Promise<void>;
};

export function MidiChannelSelect({ value, onChange, onRefreshDevices }: MidiChannelSelectProps) {
  return (
    <select
      value={value}
      onChange={onChange}
      onClick={async () => {
        if (onRefreshDevices) await onRefreshDevices();
      }}
    >
      <option value=""> All channels </option>
      {MIDI_CHANNELS.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
