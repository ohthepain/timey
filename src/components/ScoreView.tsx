import { useEffect, useRef } from "react";
import Vex, { Beam, Stem, Flow, Renderer, Stave, StaveNote, EasyScore, Formatter, Articulation, Barline, Modifier } from "vexflow";

export const ScoreView: React.FC<{ notes?: string }> = ({ notes = "C#5/q, B4, A4, G#4" }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = ""; // Clear previous rendering

    // Create and size an SVG and get a drawing context:
    const vf = new Vex.Factory({
      renderer: { elementId: 'scoreview', width: containerRef.current.clientWidth, height: 200 },
    });

    const score = vf.EasyScore();
    const system = vf.System();
    const context = vf.getContext();

    const notes = [
      // A quarter-note C.
      new StaveNote({ keys: ["c/4"], duration: "q" }),

      // A quarter-note D.
      new StaveNote({ keys: ["d/4"], duration: "q" }),

      // A quarter-note rest. Note that the key (b/4) specifies the vertical
      // position of the rest.
      new StaveNote({ keys: ["b/4"], duration: "qr" }),

      // A C-Major chord.
      new StaveNote({ keys: ["c/4", "e/4", "g/4"], duration: "q" }),
    ];
    
    const kickNotes = [
      new StaveNote({ keys: ["f/4"], duration: "q" }),
      new StaveNote({ keys: ["f/4"], duration: "qr" }),
      new StaveNote({ keys: ["f/4"], duration: "q" }),
      new StaveNote({ keys: ["f/4"], duration: "qr" }),
    ]; 

        
    const snareNotes = [
      new StaveNote({ keys: ["c/5"], duration: "qr" }),
      new StaveNote({ keys: ["c/5"], duration: "q" }),
      new StaveNote({ keys: ["c/5"], duration: "qr" }),
      new StaveNote({ keys: ["c/5"], duration: "q" }),
    ]; 

    const voice = score.voice(notes, { time: '4/4' });
    const kickVoice = score.voice(kickNotes, { time: '4/4' })
    const voices = [voice, kickVoice];
    const formatter = new Formatter().joinVoices(voices).format(voices, 750);

    // Create a voice and format the notes
    const stave : Stave = system.addStave({
      voices: voices
    })
    .addClef('percussion').addTimeSignature('4/4')
    .setBegBarType(Barline.type.REPEAT_BEGIN)
    .setEndBarType(Barline.type.REPEAT_END); 
    
    // Draw it!
    vf.draw();

    // Create beams for every **pair** of 8th notes
    const beams = Beam.generateBeams(notes);
    // voice.draw(context, stave);
    beams.forEach((beam) => beam.setContext(context).draw());

  }, [notes]);

  return <div className="h-full w-full bg-orange-400 border-2 border-l-purple-400" ref={containerRef}>ScoreView</div>;
};


    // notes.forEach((note) => {
    //   if (note.getKeys().length > 1) {
    //     const x = note.getAbsoluteX() + 5;
    //     const yTop = stave.getYForLine(0);
    //     const yBottom = stave.getYForLine(5);
    
    //     context.beginPath();
    //     context.moveTo(x, yTop);
    //     context.lineTo(x, yBottom);
    //     context.strokeStyle = "black";
    //     context.setLineWidth(2);
    //     context.stroke();
    //   }
    // });