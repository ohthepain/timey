interface TempoLadderProps {
  tempos: number[];
  currentTempo: number;
  onSelectTempo: (tempo: number) => void;
}

export function TempoLadder({ tempos, currentTempo, onSelectTempo }: TempoLadderProps) {
  return (
    <div className="flex flex-col">
      {tempos.map((tempo) => (
        <button
          key={tempo}
          className={`px-2 mx-1 font-bold text-xs py-1 rounded ${tempo === currentTempo ? 'bg-blue-500 text-white hover:bg-blue-700' : 'bg-blue-100 hover:bg-blue-300 text-blue-800'}`}
          onClick={() => onSelectTempo(tempo)}
        >
          {tempo}
        </button>
      ))}
    </div>
  );
}
