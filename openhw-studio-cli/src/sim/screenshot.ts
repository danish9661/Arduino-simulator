import type { OpenHwProject, SimulationSnapshot, SimulationTelemetryReport } from '../types.js';
import { getManifestInfo, type ManifestInfo } from '../utils/manifests.js';

interface Point {
  x: number;
  y: number;
}

function esc(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusColor(status: string): string {
  if (status === 'error') return '#ef4444';
  if (status === 'warn') return '#f59e0b';
  return '#22c55e';
}

function roleColor(role: string): string {
  if (role === 'board') return '#0ea5e9';
  if (role === 'input') return '#8b5cf6';
  if (role === 'output') return '#f97316';
  return '#64748b';
}

function manifestPinPoint(manifest: ManifestInfo | null, pinId: string): Point | null {
  if (!manifest) return null;
  const pin = manifest.pins.find((p) => p.id === pinId);
  if (!pin) return null;
  if (!Number.isFinite(Number(pin.x)) || !Number.isFinite(Number(pin.y))) {
    return null;
  }
  return { x: Number(pin.x), y: Number(pin.y) };
}

function connectionPointForEndpoint(
  endpoint: string,
  componentsById: Map<string, { x: number; y: number; w: number; h: number }>,
  manifestByType: Map<string, ManifestInfo | null>,
  typeByComponentId: Map<string, string>
): Point {
  const [componentId, pinIdRaw] = String(endpoint || '').split(':');
  const pinId = String(pinIdRaw || '');
  const comp = componentsById.get(componentId);

  if (!comp) return { x: 0, y: 0 };

  const compType = typeByComponentId.get(componentId) || '';
  const manifest = manifestByType.get(compType) || null;
  const pinPoint = manifestPinPoint(manifest, pinId);

  if (pinPoint) {
    return {
      x: comp.x + pinPoint.x,
      y: comp.y + pinPoint.y,
    };
  }

  return {
    x: comp.x + comp.w / 2,
    y: comp.y + comp.h / 2,
  };
}

export async function renderSnapshotSvg(
  project: OpenHwProject,
  snapshot: SimulationSnapshot,
  telemetry?: SimulationTelemetryReport
): Promise<string> {
  const components = snapshot.components;
  const margin = 70;

  const minX = components.length ? Math.min(...components.map((c) => c.x)) : 0;
  const minY = components.length ? Math.min(...components.map((c) => c.y)) : 0;
  const maxX = components.length ? Math.max(...components.map((c) => c.x + c.w)) : 1024;
  const maxY = components.length ? Math.max(...components.map((c) => c.y + c.h)) : 768;

  const sceneW = Math.max(640, maxX - minX + margin * 2);
  const sceneH = Math.max(420, maxY - minY + margin * 2 + 180);

  const normalizeX = (x: number) => x - minX + margin;
  const normalizeY = (y: number) => y - minY + margin + 40;

  const manifestByType = new Map<string, ManifestInfo | null>();
  const typeByComponentId = new Map<string, string>();
  const componentsById = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (const c of components) {
    typeByComponentId.set(c.id, c.type);
    componentsById.set(c.id, {
      x: normalizeX(c.x),
      y: normalizeY(c.y),
      w: c.w,
      h: c.h,
    });

    if (!manifestByType.has(c.type)) {
      manifestByType.set(c.type, await getManifestInfo(c.type));
    }
  }

  const telemetryById = new Map(
    (telemetry?.components || []).map((c) => [c.id, c])
  );

  const wireLines = snapshot.connections
    .map((wire) => {
      const from = connectionPointForEndpoint(wire.from, componentsById, manifestByType, typeByComponentId);
      const to = connectionPointForEndpoint(wire.to, componentsById, manifestByType, typeByComponentId);
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${esc(
        String(wire.color || '#ef4444')
      )}" stroke-width="2" opacity="0.85" />`;
    })
    .join('\n');

  const cards = components
    .map((component) => {
      const pos = componentsById.get(component.id)!;
      const telemetryItem = telemetryById.get(component.id);
      const role = telemetryItem?.role || (/(arduino|esp32|rp2040|stm32|pico)/i.test(component.type) ? 'board' : 'other');
      const roleCol = roleColor(role);
      const statusCol = statusColor(telemetryItem?.status || 'ok');
      const updates = Number(telemetryItem?.updates || 0);
      const summary = telemetryItem?.outputSummary || '';

      const lines: string[] = [];
      let y = pos.y + 48;
      if (summary) {
        lines.push(`<text x="${pos.x + 10}" y="${y}" fill="#e2e8f0" font-size="11">${esc(summary).slice(0, 120)}</text>`);
        y += 14;
      }
      const keys = telemetryItem?.changedKeys || [];
      if (keys.length > 0) {
        lines.push(
          `<text x="${pos.x + 10}" y="${y}" fill="#94a3b8" font-size="10">changed: ${esc(keys.slice(0, 6).join(', '))}</text>`
        );
      }

      return `
<g>
  <rect x="${pos.x}" y="${pos.y}" width="${component.w}" height="${component.h}" rx="8" fill="#0f172a" stroke="#334155" stroke-width="1.5" />
  <rect x="${pos.x}" y="${pos.y}" width="${component.w}" height="22" rx="8" fill="${roleCol}" opacity="0.24" />
  <rect x="${pos.x + component.w - 24}" y="${pos.y + 5}" width="18" height="12" rx="6" fill="${statusCol}" />
  <text x="${pos.x + 10}" y="${pos.y + 15}" fill="#e2e8f0" font-size="12" font-weight="700">${esc(component.label)}</text>
  <text x="${pos.x + 10}" y="${pos.y + 34}" fill="#93c5fd" font-size="10">${esc(component.type)}</text>
  <text x="${pos.x + component.w - 10}" y="${pos.y + 34}" fill="#cbd5e1" font-size="10" text-anchor="end">updates=${updates}</text>
  ${lines.join('\n  ')}
</g>`;
    })
    .join('\n');

  const boardSummaryLines = (telemetry?.boards || snapshot.boards.map((b) => ({
    id: b.id,
    type: b.type,
    serialChars: 0,
    faultCount: 0,
  })))
    .map((b, idx) => {
      return `<text x="28" y="${sceneH - 120 + idx * 16}" fill="#e2e8f0" font-size="11">${esc(
        `${b.id} (${b.type}) serial=${b.serialChars} faults=${b.faultCount}`
      )}</text>`;
    })
    .join('\n');

  const generatedAt = telemetry?.generatedAt || snapshot.capturedAt;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sceneW}" height="${sceneH}" viewBox="0 0 ${sceneW} ${sceneH}">
  <defs>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" stroke-width="1" />
    </pattern>
  </defs>

  <rect x="0" y="0" width="${sceneW}" height="${sceneH}" fill="#020617" />
  <rect x="0" y="0" width="${sceneW}" height="${sceneH}" fill="url(#grid)" opacity="0.5" />

  <text x="24" y="30" fill="#e2e8f0" font-size="16" font-weight="700">OpenHW Simulation Snapshot</text>
  <text x="24" y="50" fill="#94a3b8" font-size="11">project=${esc(project.name)} | captured=${esc(generatedAt)}</text>
  <text x="24" y="66" fill="#94a3b8" font-size="11">components=${components.length} | wires=${snapshot.connections.length} | faults=${Number(
    telemetry?.faults || 0
  )}</text>

  <g>${wireLines}</g>
  <g>${cards}</g>

  <rect x="16" y="${sceneH - 150}" width="${sceneW - 32}" height="130" rx="8" fill="#0b1220" stroke="#1f2937" />
  <text x="28" y="${sceneH - 130}" fill="#e2e8f0" font-size="12" font-weight="700">Board Runtime Summary</text>
  ${boardSummaryLines}
</svg>`;
}
