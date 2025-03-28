import { useEffect, useRef } from 'react';
import Vex, {
  Beam,
  Stem,
  Renderer,
  Stave,
  StaveNote,
  EasyScore,
  Formatter,
  Articulation,
  Barline,
  Modifier,
  StemmableNote,
} from 'vexflow';
import Flow from 'vexflow';

export const PercussionScore: React.FC<{ notes?: string }> = ({
  notes = 'C#5/q, B4, A4, G#4',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ''; // Clear previous rendering

    // Create and size an SVG and get a drawing context:
    const f = new Vex.Factory({
      renderer: {
        elementId: 'percussionscore',
        width: containerRef.current.clientWidth,
        height: 200,
      },
    });

    // const system = f.System();
    const context = f.getContext();

    const stave = f
      .Stave({
        x: 10,
        y: 40,
      })
      .addClef('percussion')
      .setTimeSignature('4/4')
      .setBegBarType(Barline.type.REPEAT_BEGIN)
      .setEndBarType(Barline.type.REPEAT_END);

    const hihatVoice = f
      .Voice()
      .addTickables([
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
        f.StaveNote({ keys: ['g/5/x2'], duration: '8' }),
      ]);

    const kickSnareVoice = f.Voice().addTickables([
      f.StaveNote({ keys: ['f/4'], duration: '8', stemDirection: -1 }),
      f.StaveNote({ keys: ['f/4'], duration: '8', stemDirection: -1 }),
      // f.StaveNote({ keys: ['d/4/x2', 'c/5'], duration: '4', stemDirection: -1 }),
      f.StaveNote({ keys: ['c/5'], duration: '4', stemDirection: -1 }),
      f.StaveNote({ keys: ['f/4'], duration: '8', stemDirection: -1 }),
      f.StaveNote({ keys: ['f/4'], duration: '8', stemDirection: -1 }),
      f.StaveNote({ keys: ['c/5'], duration: '4', stemDirection: -1 }),
      // f.StaveNote({ keys: ['d/4/x2', 'c/5'], duration: '4', stemDirection: -1 }),
    ]);

    f.Formatter().joinVoices(f.getVoices()).formatToStave(f.getVoices(), stave);

    f.Beam({ notes: hihatVoice.getTickables() as StemmableNote[] });
    f.Beam({
      notes: kickSnareVoice.getTickables().slice(0, 2) as StemmableNote[],
    });
    f.Beam({
      notes: kickSnareVoice.getTickables().slice(3, 5) as StemmableNote[],
    });

    f.Formatter().joinVoices(f.getVoices()).formatToStave(f.getVoices(), stave);
    f.draw();
  }, [notes]);

  return (
    <div
      className="h-full w-full bg-orange-400 border-2 border-l-purple-400"
      ref={containerRef}
    >
      PercussionScore
    </div>
  );
};
