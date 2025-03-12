import { useEffect, useRef } from "react";
import Vex, { Flow, Renderer, Stave, StaveNote, EasyScore, Formatter, Articulation, Barline, Modifier } from "vexflow";

export const ScoreViewer: React.FC<{ notes?: string }> = ({ notes = "C#5/q, B4, A4, G#4" }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    const vf = new Vex.Factory({
      renderer: { elementId: 'score', width: 500, height: 200 },
    });

    const score = vf.EasyScore();
    const system = vf.System();

    // Define a voice with hi-hats (X noteheads) and snare
    const hihatNotes = [
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
      new StaveNote({ keys: ["g/5"], duration: "8" }),
    ];

    // Create a voice and format the notes
    system.addStave({
      voices: [
        // Top voice has 4 quarter notes with stems up.
        score.voice(score.notes('C#5/q, B4, A4, G4', { stem: 'up' })),
       
        // Bottom voice has two half notes, with stems down.
        score.voice(score.notes('C#4/h, C#4', { stem: 'down' })),

        score.voice(hihatNotes, { time: '4/4' }),
      ]
    })
    .addClef('percussion').addTimeSignature('4/4')
    .setBegBarType(Barline.type.REPEAT_BEGIN)
    .setEndBarType(Barline.type.REPEAT_END); 
    
    // Draw it!
    vf.draw();
  }, [notes]);

  return <div ref={containerRef}></div>;
};
