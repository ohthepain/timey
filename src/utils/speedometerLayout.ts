import { circleCenterAndArc, getPointOnCircle } from '~/utils/circleCenter';

export type SpeedometerLayout = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  r: number;
  arcRadians: number;
  strokeWidth: number;
  needle: { x: number; y: number };
  instantNeedle: { x: number; y: number };
};

function needlePoint(
  min: number,
  max: number,
  value: number,
  arc: { x: number; y: number; arc: number },
  radius: number,
  strokeWidth: number
) {
  const radians = Math.PI / 2 - arc.arc / 2 + ((value - min) / (max - min)) * arc.arc;
  return getPointOnCircle(arc.x, arc.y + strokeWidth * 2, -radius, radians);
}

export function measureSpeedometerLayout(
  clientWidth: number,
  clientHeight: number,
  min: number,
  max: number,
  value: number,
  instantValue?: number
): SpeedometerLayout {
  const strokeWidth = clientHeight / 8;
  const arc = circleCenterAndArc(
    strokeWidth / 2,
    clientHeight,
    clientWidth / 2,
    strokeWidth / 2,
    clientWidth,
    clientHeight
  );
  const radius = arc.y;
  const needle = needlePoint(min, max, value, arc, radius, strokeWidth);
  const instantNeedle = needlePoint(min, max, instantValue ?? value, arc, radius, strokeWidth);
  return {
    width: clientWidth,
    height: clientHeight,
    cx: arc.x,
    cy: arc.y + 8,
    r: arc.y,
    arcRadians: arc.arc,
    strokeWidth,
    needle,
    instantNeedle,
  };
}
