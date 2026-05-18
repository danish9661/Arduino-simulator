// Tuned spacing/tolerance for bundling
const WIRE_SPACING = 7;
const OVERLAP_TOLERANCE = 4;

function dedupePoints(points) {
  const out = [];
  for (const pt of points || []) {
    if (!pt) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - pt.x) < 0.1 && Math.abs(last.y - pt.y) < 0.1) continue;
    out.push({ x: pt.x, y: pt.y });
  }
  return out;
}

function orthogonalizePair(a, b, horizontalFirst) {
  if (Math.abs(a.x - b.x) < 0.1 || Math.abs(a.y - b.y) < 0.1) return [a, b];
  if (horizontalFirst) {
    return [a, { x: b.x, y: a.y }, b];
  }
  return [a, { x: a.x, y: b.y }, b];
}

function buildBaseRoutePoints(p1, e1, e2, p2, waypoints = [], offset = 0) {
  if (!p1 || !e1 || !e2 || !p2) return [];

  const cleanedWaypoints = Array.isArray(waypoints) ? waypoints.filter(Boolean) : [];
  if (cleanedWaypoints.length > 0) {
    const pts = [p1, e1, ...cleanedWaypoints, e2, p2];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const prev = out[out.length - 1];
      const curr = pts[i];
      const horizontalFirst = Math.abs(curr.x - prev.x) >= Math.abs(curr.y - prev.y);
      out.push(...orthogonalizePair(prev, curr, horizontalFirst).slice(1));
    }
    return dedupePoints(out);
  }

  const dx = e2.x - e1.x;
  const dy = e2.y - e1.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const shift = Number(offset) || 0;

  let route;
  if (horizontalFirst) {
    const trunkY = e1.y + shift;
    route = [
      p1,
      e1,
      { x: e1.x, y: trunkY },
      { x: e2.x, y: trunkY },
      e2,
      p2,
    ];
  } else {
    const trunkX = e1.x + shift;
    route = [
      p1,
      e1,
      { x: trunkX, y: e1.y },
      { x: trunkX, y: e2.y },
      e2,
      p2,
    ];
  }

  return dedupePoints(route);
}

function segmentsFromPoints(points, wireId) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1) continue;
    const vertical = Math.abs(a.x - b.x) < Math.abs(a.y - b.y);
    segments.push({
      wireId,
      vertical,
      start: { x: a.x, y: a.y },
      end: { x: b.x, y: b.y },
      centerLine: vertical ? a.x : a.y,
    });
  }
  return segments;
}

function overlapRange(seg) {
  if (seg.vertical) {
    return [Math.min(seg.start.y, seg.end.y), Math.max(seg.start.y, seg.end.y)];
  }
  return [Math.min(seg.start.x, seg.end.x), Math.max(seg.start.x, seg.end.x)];
}

function segmentsOverlap(a, b) {
  if (a.vertical !== b.vertical) return false;
  if (Math.abs(a.centerLine - b.centerLine) > OVERLAP_TOLERANCE) return false;
  const [a0, a1] = overlapRange(a);
  const [b0, b1] = overlapRange(b);
  return !(a1 < b0 || b1 < a0);
}

export function calculateWireBundleOffsets(wires, resolveWirePoints) {
  const offsets = new Map();
  for (const wire of wires || []) {
    if (wire?.id != null) offsets.set(wire.id, 0);
  }

  const allSegments = [];
  for (const wire of wires || []) {
    const resolved = resolveWirePoints ? resolveWirePoints(wire) : null;
    if (!resolved) continue;
    // build the canonical trunk-first route (no offset) for overlap detection
    const points = buildBaseRoutePoints(resolved.p1, resolved.e1, resolved.e2, resolved.p2, resolved.waypoints || [], 0);
    if (points.length < 2) continue;
    allSegments.push(...segmentsFromPoints(points, wire.id));
  }

  const groups = [];
  const seen = new Set();
  for (let i = 0; i < allSegments.length; i++) {
    if (seen.has(i)) continue;
    const seed = allSegments[i];
    const group = [seed];
    seen.add(i);
    for (let j = i + 1; j < allSegments.length; j++) {
      if (seen.has(j)) continue;
      const seg = allSegments[j];
      if (group.some(item => segmentsOverlap(item, seg))) {
        group.push(seg);
        seen.add(j);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  for (const group of groups) {
    // Determine stable ordering by computing each wire's average centerLine
    const wireToCenter = new Map();
    for (const seg of group) {
      const cur = wireToCenter.get(seg.wireId) || { sum: 0, n: 0 };
      cur.sum += seg.centerLine; cur.n += 1;
      wireToCenter.set(seg.wireId, cur);
    }
    const uniqueWireIds = [...new Set(group.map(seg => seg.wireId))].filter(id => id != null);
    uniqueWireIds.sort((a, b) => {
      const aa = wireToCenter.get(a) || { sum: 0, n: 1 };
      const bb = wireToCenter.get(b) || { sum: 0, n: 1 };
      return (aa.sum / aa.n) - (bb.sum / bb.n);
    });
    const count = uniqueWireIds.length;
    uniqueWireIds.forEach((wireId, index) => {
      const offset = (index - (count - 1) / 2) * WIRE_SPACING;
      const current = offsets.get(wireId) || 0;
      if (Math.abs(offset) > Math.abs(current)) {
        offsets.set(wireId, offset);
      }
    });
    // Debug: report grouping and assigned offsets
    try {
      console.debug('[wireRouting] group assigned', group.map(s => ({ wireId: s.wireId, centerLine: s.centerLine })), 'offsetsSnapshot', uniqueWireIds.map(id => ({ id, offset: offsets.get(id) })));
    } catch (e) {
      // noop in environments without console
    }
  }

  try {
    console.debug('[wireRouting] final offsets map', Array.from(offsets.entries()));
  } catch (e) {}

  return offsets;
}

export function buildWireRoutePoints(p1, e1, e2, p2, waypoints = [], offset = 0) {
  return buildBaseRoutePoints(p1, e1, e2, p2, waypoints, offset);
}
