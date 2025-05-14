import { memo } from 'react';

interface LadderProps {
  values: number[];
  currentValue: number;
  onSelectValue?: (value: number) => void;
}

function LadderComponent({ values, currentValue, onSelectValue }: LadderProps) {
  if (!values.includes(currentValue)) {
    if (currentValue < values[0]) {
      currentValue = values[0];
    } else {
      currentValue = values[values.length - 1];
    }
  }

  return (
    <div className="inline-flex flex-col justify-around h-full">
      {values.map((value) => (
        <button
          key={value}
          className={`w-full px-2 mx-1 font-bold text-xs py-1 rounded ${
            value === currentValue
              ? 'bg-blue-500 text-white hover:bg-blue-700'
              : 'bg-blue-100 hover:bg-blue-300 text-blue-800'
          }`}
          onClick={() => {
            onSelectValue?.(value);
          }}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

export const Ladder = memo(LadderComponent);
