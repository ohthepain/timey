import { useRef, useEffect, useState } from 'react';
import { measureSpeedometerLayout } from '~/utils/speedometerLayout';

type SpeedometerProps = {
  min: number;
  max: number;
  value: number;
  bgColor?: string;
  instantValue?: number;
};

export const Speedometer = (props: SpeedometerProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [layout, setLayout] = useState(() =>
    measureSpeedometerLayout(1, 1, props.min, props.max, props.value, props.instantValue)
  );
  const [bgColor, setBgColor] = useState('bg-gray-200');

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const updateSize = () => {
      setLayout(
        measureSpeedometerLayout(
          svg.clientWidth,
          svg.clientHeight,
          props.min,
          props.max,
          props.value,
          props.instantValue
        )
      );
      setBgColor(props.bgColor || 'bg-gray-200');
    };

    updateSize();
    const observer = new window.ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [props.min, props.max, props.value, props.instantValue, props.bgColor]);

  return (
    <div className={bgColor}>
      <svg ref={svgRef} width="100%" height="100%">
        <circle cx={layout.cx} cy={layout.cy} r={layout.r} fill="none" stroke="gray" strokeWidth={layout.strokeWidth} />
        {props.instantValue !== undefined && (
          <line
            x1={layout.cx}
            y1={layout.cy}
            x2={layout.instantNeedle.x}
            y2={layout.instantNeedle.y}
            stroke="yellow"
            strokeWidth={8}
            strokeLinecap="round"
          />
        )}
        <line
          x1={layout.cx}
          y1={layout.cy}
          x2={layout.needle.x}
          y2={layout.needle.y}
          stroke="black"
          strokeWidth={8}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
};
