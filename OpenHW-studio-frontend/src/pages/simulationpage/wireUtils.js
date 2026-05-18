import { buildWireRoutePoints } from '../../utils/wireRouting.js';
import { makeOrthogonal } from '../../utils/wireUtils.js';

function snapPointsToHalfPixel(pts) {
  return (pts || []).map(p => ({ x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2, _corner: p._corner }));
}

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
    const out = pts.filter((pt, i, arr) => i === 0 || Math.abs(pt.x - arr[i - 1].x) > 0.1 || Math.abs(pt.y - arr[i - 1].y) > 0.1);
    return snapPointsToHalfPixel(makeOrthogonal(out));
  }
  const pts = buildWireRoutePoints(p1, e1, e2, p2, waypoints, offset);
  return snapPointsToHalfPixel(makeOrthogonal(pts));
}


// ─── BUILD FULL WIRE PATH STRING ───────────────────────────────────────────

export function buildWirePath(p1, e1, e2, p2, waypoints = [], pathOverride = null, offset = 0) {
  const rawPts = Array.isArray(pathOverride) && pathOverride.length > 1
    ? pathOverride
    : computeWireOrthoPoints(p1, e1, e2, p2, waypoints, offset);
  const pts = snapPointsToHalfPixel(makeOrthogonal(rawPts));
  return renderRoundedPath(pts);
}

// ─── GET WIRE POINTS FOR DRAGGING ──────────────────────────────────────────
export function getWirePoints(p1, e1, e2, p2, waypoints = [], offset = 0) {
  const pts = computeWireOrthoPoints(p1, e1, e2, p2, waypoints, offset);
  return snapPointsToHalfPixel(makeOrthogonal(pts));
}

// ─── PREVIEW WIRE ROUTER (Drawing mode) ───────────────────────────────────
export function multiRoutePath(p1, p2, waypoints = []) {
  if (!p1 || !p2) return '';
  const hints = [p1, ...waypoints, p2];
  const pts = [];
  for (let i = 0; i < hints.length - 1; i++) {
    const a = hints[i], b = hints[i + 1];
    if (i === 0) pts.push(a);
    const midX = (a.x + b.x) / 2;
    pts.push({ x: midX, y: a.y });
    pts.push({ x: midX, y: b.y });
    pts.push(b);
  }
  return renderRoundedPath(makeOrthogonal(pts));
}

// ─── AUTOMATED WIRE COLORING LOGIC ────────────────────────────────────────
export function wireColor(pinLabel) {
  if (!pinLabel) return '#2ecc71';
  const l = pinLabel.toUpperCase();

  // Power & Ground (Highest priority)
  if (l === 'GND' || l.includes('.GND') || l.includes('_GND') || l === 'VSS' || l === 'CATHODE' || l === 'COM') return '#1f2937'; 
  if (l === 'VCC' || l === 'VDD' || l === '5V' || l === '3V3' || l === '3.3V' || l === 'VIN' || l === 'ANODE' || l === 'V+') return '#ef4444'; 

  // UART
  if (l.includes('RX')) return '#f97316'; // Orange
  if (l.includes('TX')) return '#ea580c'; // Deep Orange

  // I2C
  if (l.includes('SDA')) return '#3b82f6'; // Blue
  if (l.includes('SCL')) return '#eab308'; // Yellow/Amber

  // SPI - Specific Signal Separation
  if (l.includes('MOSI') || l.includes('DIN') || l.includes('SDI')) return '#8b5cf6'; // Violet
  if (l.includes('MISO') || l.includes('DOUT') || l.includes('SDO')) return '#d946ef'; // Fuchsia
  if (l === 'SCK') return '#6366f1';  // Indigo
  if (l.includes('SCLK') || l.includes('CLK')) return '#4f46e5'; // Deep Indigo
  if (l === 'CS') return '#ec4899';   // Pink
  if (l.includes('SS') || l.includes('SCE')) return '#be185d';  // Deep Pink/Maroon

  // Analog
  if ((l.startsWith('A') && !isNaN(l.substring(1))) || l.includes('ANALOG') || l.includes('ADC')) return '#10b981'; // Emerald

  // PWM / Special
  if (l.includes('PWM') || l.includes('~') || l.includes('EN')) return '#06b6d4'; // Cyan

  return '#2ecc71'; // Default Green
}
