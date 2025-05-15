import { useRef, useEffect, useState } from 'react';
import { circleCenterAndArc, getPointOnCircle } from '~/utils/circleCenter';

type SpeedometerProps = {
  min: number;
  max: number;
  value: number;
  bgColor?: string;
  instantValue?: number;
};

const textOn = false;

export const Speedometer = (props: SpeedometerProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const minTextRef = useRef<SVGTextElement | null>(null);
  const maxTextRef = useRef<SVGTextElement | null>(null);
  const currentTextRef = useRef<SVGTextElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, cx: 0, cy: 0, r: 1, arcRadians: 0 });
  const [strokeWidth, setStrokeWidth] = useState(0);
  const [pointOnCircle, setPointOnCircle] = useState({ x: 0, y: 0 });
  const [pointOnCircleInstant, setPointOnCircleInstant] = useState({ x: 0, y: 0 });
  const [bgColor, setBgColor] = useState('bg-gray-200');
  const [animatedValue, setAnimatedValue] = useState(props.value);

  // Animate displayed value toward props.value at ~30fps
  const animate = false;
  if (animate) {
    useEffect(() => {
      let frame: number;
      const fps = 30;
      const interval = 1000 / fps;
      let lastTime = performance.now();

      function animate(now: number) {
        const elapsed = now - lastTime;
        if (elapsed >= interval) {
          lastTime = now;
          setAnimatedValue((prev) => {
            // Smoothly approach props.value
            const diff = props.value - prev;
            if (Math.abs(diff) < 0.01) return props.value;
            // Move a fraction toward the target (lerp)
            return prev + diff * 0.2;
          });
        }
        frame = requestAnimationFrame(animate);
      }
      frame = requestAnimationFrame(animate);
      return () => cancelAnimationFrame(frame);
    }, [props.value]);
  }

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
      let radians = Math.PI / 2 - arc.arc / 2 + ((animatedValue - props.min) / (props.max - props.min)) * arc.arc;
      let pt = getPointOnCircle(arc.x, arc.y + strokeWidth * 2, -radius, radians);

      setPointOnCircle(pt);

      if (props.instantValue) {
        radians = Math.PI / 2 - arc.arc / 2 + ((props.instantValue - props.min) / (props.max - props.min)) * arc.arc;
        pt = getPointOnCircle(arc.x, arc.y + strokeWidth * 2, -radius, radians);
      }

      setPointOnCircleInstant(pt);

      // Create text elements if they don't exist
      if (textOn) {
        if (!minTextRef.current && svg) {
          const textColor = 'white';
          const fontSize = strokeWidth * 1.1;

          // Min value (top left)
          const minText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          minText.setAttribute('x', '12');
          minText.setAttribute('y', '20');
          minText.setAttribute('text-anchor', 'start');
          minText.setAttribute('fill', textColor);
          minText.setAttribute('font-size', fontSize.toString());
          svg.appendChild(minText);
          minTextRef.current = minText;

          // Max value (top right)
          const maxText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          maxText.setAttribute('x', (svg.clientWidth - 10).toString());
          maxText.setAttribute('y', '20');
          maxText.setAttribute('text-anchor', 'end');
          maxText.setAttribute('fill', textColor);
          maxText.setAttribute('font-size', fontSize.toString());
          svg.appendChild(maxText);
          maxTextRef.current = maxText;

          // Current value (bottom center)
          const currentText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          currentText.setAttribute('x', (svg.clientWidth / 2).toString());
          currentText.setAttribute('y', (svg.clientHeight - 10).toString());
          currentText.setAttribute('text-anchor', 'middle');
          currentText.setAttribute('fill', textColor);
          currentText.setAttribute('font-size', fontSize.toString());
          svg.appendChild(currentText);
          currentTextRef.current = currentText;
        }

        // Update text content and positions
        if (minTextRef.current) {
          minTextRef.current.textContent = props.min.toFixed(0);
        }
        if (maxTextRef.current && svg) {
          maxTextRef.current.textContent = props.max.toFixed(0);
        }
        if (currentTextRef.current && svg) {
          currentTextRef.current.textContent = animatedValue.toFixed(0);
        }
      }
    }

    setBgColor(props.bgColor || 'bg-gray-200');
    updateSize();

    const observer = new window.ResizeObserver(updateSize);
    observer.observe(svg);

    return () => observer.disconnect();
  }, [props, animatedValue]);

  return (
    <div className={bgColor}>
      <svg ref={svgRef} width="100%" height="100%">
        <circle cx={size.cx} cy={size.cy} r={size.r} fill="none" stroke="gray" strokeWidth={strokeWidth} />
        {props.instantValue && (
          <line
            x1={size.cx}
            y1={size.cy}
            x2={pointOnCircleInstant.x}
            y2={pointOnCircleInstant.y}
            stroke="white"
            strokeWidth={8}
            strokeLinecap="round"
          />
        )}
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
