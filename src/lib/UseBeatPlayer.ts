import { useEffect, useState } from 'react';
import { beatPlayer } from '~/lib/BeatPlayer';
import { NoteEntry } from '~/lib/ParseBeat';

export const useBeatPlayer = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentNote, setCurrentNote] = useState<NoteEntry | null>(null);
  const [tempo, setTempo] = useState(120);

  useEffect(() => {
    const handlePlay = () => setIsPlaying(true);
    const handleStop = () => setIsPlaying(false);
    const handleNotePlayed = (note: NoteEntry) => setCurrentNote(note);
    const handleTempoChanged = (newTempo: number) => setTempo(newTempo);

    beatPlayer.on('play', handlePlay);
    beatPlayer.on('stop', handleStop);
    beatPlayer.on('notePlayed', handleNotePlayed);
    beatPlayer.on('tempoChanged', handleTempoChanged);

    return () => {
      beatPlayer.off('play', handlePlay);
      beatPlayer.off('stop', handleStop);
      beatPlayer.off('notePlayed', handleNotePlayed);
      beatPlayer.off('tempoChanged', handleTempoChanged);
    };
  }, []);

  return { isPlaying, currentNote, tempo };
};
