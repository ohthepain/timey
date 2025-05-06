// Returns the center (h, k) of the circle passing through three points
// (x0, y0), (x1, y1), (x2, y2)
export function circleCenter(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number } {
  let D = 2 * (x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1));
  if (D === 0) {
    D = 1; // Points are collinear
  }
  const h = ((x0 ** 2 + y0 ** 2) * (y1 - y2) + (x1 ** 2 + y1 ** 2) * (y2 - y0) + (x2 ** 2 + y2 ** 2) * (y0 - y1)) / D;
  const k = ((x0 ** 2 + y0 ** 2) * (x2 - x1) + (x1 ** 2 + y1 ** 2) * (x0 - x2) + (x2 ** 2 + y2 ** 2) * (x1 - x0)) / D;
  return { x: h, y: k };
}

export function circleCenterAndArc(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number; arc: number } {
  let D = 2 * (x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1));
  if (D === 0) {
    // Points are collinear
    D = 1;
  }

  const h = ((x0 ** 2 + y0 ** 2) * (y1 - y2) + (x1 ** 2 + y1 ** 2) * (y2 - y0) + (x2 ** 2 + y2 ** 2) * (y0 - y1)) / D;
  const k = ((x0 ** 2 + y0 ** 2) * (x2 - x1) + (x1 ** 2 + y1 ** 2) * (x0 - x2) + (x2 ** 2 + y2 ** 2) * (x1 - x0)) / D;

  // Angles from center to each point
  const a0 = Math.atan2(y0 - k, x0 - h);
  const a1 = Math.atan2(y1 - k, x1 - h);
  const a2 = Math.atan2(y2 - k, x2 - h);

  // Arc in radians between a0 and a2, passing through a1
  let arc = (a2 - a0 + 2 * Math.PI) % (2 * Math.PI);
  const a1Rel = (a1 - a0 + 2 * Math.PI) % (2 * Math.PI);
  if (a1Rel > arc) {
    arc = (a0 - a2 + 2 * Math.PI) % (2 * Math.PI);
  }

  return { x: h, y: k, arc: arc };
}

export function getPointOnCircle(cx: number, cy: number, radius: number, radians: number): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}
