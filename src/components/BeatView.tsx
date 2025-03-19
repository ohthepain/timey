import { useEffect, useRef } from "react";
import Vex, { Beam, Barline, EasyScore } from "vexflow";

const concat = (a: any[], b: any[]): any[] => a.concat(b);

export const BeatView: React.FC<{ notes?: string }> = ({ notes = "C#5/q, B4, A4, G#4" }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    // Create and size an SVG and get a drawing context:
    const f = new Vex.Factory({ renderer: { elementId: 'beatview', width: containerRef.current.clientWidth, height: 200 }, });

    const stave = f.Stave({ x: 10, y: 40, })
      .addClef('percussion')
      .setTimeSignature('4/4')
      .setBegBarType(Barline.type.REPEAT_BEGIN)
      .setEndBarType(Barline.type.REPEAT_END); 

    const score = f.EasyScore();
    const voice = score.voice(
      [
        score.tuplet(score.notes('c4/8, g4, f5')),
        score.notes('d5/8'),
        score.tuplet(score.notes('c5/16, (c4 e4 g4), f4')),
        score.notes('d5/8, e5'),
        score.notes('c4, f5/32, f5, f5, f5'),
      ].reduce(concat)
    );

    const beams = Beam.applyAndGetBeams(voice);
    f.Formatter().joinVoices(f.getVoices()).formatToStave(f.getVoices(), stave);
    f.draw();
    beams.forEach((beam) => beam.setContext(f.getContext()).draw());

  }, [notes]);

  return <div className="h-full w-full bg-orange-400 border-2 border-l-purple-400" ref={containerRef}>BeatView</div>;
};
