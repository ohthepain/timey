import { useRef, useEffect, useState } from 'react';
import { b } from 'vitest/dist/chunks/suite.d.FvehnV49.js';
import { set } from 'zod';
import { circleCenterAndArc, getPointOnCircle } from '~/utils/circleCenter';

type SpeedometerProps = {
  min: number;
  max: number;
  value: number;
  bgColor?: string;
};

export const Speedometer = (props: SpeedometerProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, cx: 0, cy: 0, r: 1, arcRadians: 0 });
  const [strokeWidth, setStrokeWidth] = useState(0);
  const [pointOnCircle, setPointOnCircle] = useState({ x: 0, y: 0 });
  const [bgColor, setBgColor] = useState('bg-gray-200');

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    function updateSize() {
      // console.log('updateSize', svg!.clientWidth, svg!.clientHeight);
      const strokeWidth = svg!.clientHeight / 8;
      setStrokeWidth(strokeWidth);
      const arc = circleCenterAndArc(
        strokeWidth / 2,
        svg!.clientHeight,
        svg!.clientWidth / 2,
        strokeWidth / 2,
        svg!.clientWidth,
        svg!.clientHeight
      );
      // console.log('arc: ---> ', arc);
      setSize({
        width: svg!.clientWidth,
        height: svg!.clientHeight,
        cx: arc.x,
        cy: arc.y + 8,
        r: arc.y,
        arcRadians: arc.arc,
      });

      const radius = arc.y;
      // console.log('arc.arc', arc.arc);
      // console.log(`(${props.value} - ${props.min}) / (${props.max} - ${props.min})`);
      const radians = Math.PI / 2 - arc.arc / 2 + ((props.value - props.min) / (props.max - props.min)) * arc.arc; // + arc.arc / 2; // - Math.PI / 2;
      // console.log('radians', radians);
      // console.log('cos', Math.cos(radians));
      // console.log('sin', Math.sin(radians));
      const pt = getPointOnCircle(arc.x, arc.y + strokeWidth * 2, -radius, radians);
      // console.log('pt', pt);

      setPointOnCircle(pt);
    }

    setBgColor(props.bgColor || 'bg-gray-200');
    updateSize();

    const observer = new window.ResizeObserver(updateSize);
    observer.observe(svg);

    return () => observer.disconnect();
  }, [props]);

  return (
    <div className={bgColor}>
      <svg ref={svgRef} width="100%" height="100%">
        <circle cx={size.cx} cy={size.cy} r={size.r} fill="none" stroke="gray" strokeWidth={strokeWidth} />
        <line
          x1={size.cx}
          y1={size.cy}
          x2={pointOnCircle.x}
          y2={pointOnCircle.y}
          stroke="black"
          strokeWidth={8}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
};
