import { buildWireRoutePoints } from '../../utils/wireRouting.js';

// ─── RENDER ROUNDED PATH FROM POINT ARRAY ─────────────────────────────────
export function renderRoundedPath(pts) {
  if (!pts || pts.length < 2) return '';
  const r = 10;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1];
    const distPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const distNext = Math.hypot(next.x - curr.x, next.y - curr.y);
    const cornerR = Math.min(r, distPrev / 2, distNext / 2);
    if (cornerR < 0.5) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }
    const ps = { x: curr.x + (prev.x - curr.x) * (cornerR / distPrev), y: curr.y + (prev.y - curr.y) * (cornerR / distPrev) };
    const pe = { x: curr.x + (next.x - curr.x) * (cornerR / distNext), y: curr.y + (next.y - curr.y) * (cornerR / distNext) };
    d += ` L ${ps.x} ${ps.y} Q ${curr.x} ${curr.y} ${pe.x} ${pe.y}`;
  }
  d += ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`;
  return d;
}

// ─── COMPUTE ORTHOGONAL WIRE CORNER POINTS ─────────────────────────────────
export function computeWireOrthoPoints(p1, e1, e2, p2, waypoints = [], offset = 0) {
  if (waypoints.length > 0 && waypoints[0]?._corner) {
    const pts = [p1, ...waypoints, p2];
    return pts.filter((pt, i, arr) => i === 0 || pt.x !== arr[i - 1].x || pt.y !== arr[i - 1].y);
  }
  return buildWireRoutePoints(p1, e1, e2, p2, waypoints, offset);
}

// ─── SINGLE SOURCE OF TRUTH: full orthogonal point list for any wire mode ──
export function getWirePoints(p1, e1, e2, p2, waypoints = [], offset = 0) {
  if (waypoints.length > 0 && waypoints[0]._corner) {
    let pts = [p1, ...waypoints, p2];
    return pts.filter((pt, i, arr) => i === 0 || pt.x !== arr[i - 1].x || pt.y !== arr[i - 1].y);
  }

  if (waypoints.length > 0) {
    const hints = [e1, ...waypoints, e2];
    let pts = [p1];
    for (let i = 0; i < hints.length - 1; i++) {
      const a = hints[i], b = hints[i + 1];
      pts.push(a);
      const midX = (a.x + b.x) / 2;
      pts.push({ x: midX, y: a.y });
      pts.push({ x: midX, y: b.y });
    }
    pts.push(e2, p2);
    return pts.filter((pt, i, arr) => i === 0 || pt.x !== arr[i - 1].x || pt.y !== arr[i - 1].y);
  }

  return computeWireOrthoPoints(p1, e1, e2, p2, [], offset);
}

// Preview wire while drawing
export function multiRoutePath(p1, p2, waypoints = []) {
  if (!p1 || !p2) return '';
  const hints = [p1, ...waypoints, p2];
  let pts = [];
  for (let i = 0; i < hints.length - 1; i++) {
    const a = hints[i], b = hints[i + 1];
    if (i === 0) pts.push(a);
    const midX = (a.x + b.x) / 2;
    pts.push({ x: midX, y: a.y });
    pts.push({ x: midX, y: b.y });
    pts.push(b);
  }
  pts = pts.filter((pt, i, arr) => i === 0 || pt.x !== arr[i - 1].x || pt.y !== arr[i - 1].y);
  return renderRoundedPath(pts);
}

// Builds the SVG path string for a placed wire.
export function buildWirePath(p1, e1, e2, p2, waypoints = [], pathOverride = null, offset = 0) {
  const pts = Array.isArray(pathOverride) && pathOverride.length > 1
    ? pathOverride
    : getWirePoints(p1, e1, e2, p2, waypoints, offset);
  return renderRoundedPath(pts);
}

export function wireColor(pinLabel) {
  if (!pinLabel) return '#2ecc71';
  const l = pinLabel.toUpperCase();
  if (l.includes('GND') || l === 'CATHODE') return '#808080';
  if (l.includes('5V') || l.includes('3.3V') || l === 'VCC' || l === 'ANODE') return '#e74c3c';
  return '#2ecc71';
}
