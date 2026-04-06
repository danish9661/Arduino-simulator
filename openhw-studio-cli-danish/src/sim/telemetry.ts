import type {
  OpenHwProject,
  SimulationComponentSnapshot,
  SimulationComponentTelemetry,
  SimulationSnapshot,
  SimulationTelemetryReport,
} from '../types.js';
import { isProgrammableBoardType } from '../utils/boards.js';
import { getManifestInfo } from '../utils/manifests.js';

interface ComponentMeta {
  id: string;
  type: string;
  label: string;
  group: string;
  role: 'board' | 'input' | 'output' | 'other';
  hasOnEvent: boolean;
  attrs: Record<string, unknown>;
  telemetryTemplate?: string;
  telemetryCriticalKeys: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

function normalizeUnknown(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    if (value.length > 256) {
      return {
        kind: 'array',
        length: value.length,
        preview: value.slice(0, 32),
      };
    }
    return value.map((item) => normalizeUnknown(item));
  }

  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) {
      const typed = value as unknown as { length?: number; [k: number]: number };
      const len = Number(typed.length || 0);
      const preview: number[] = [];
      for (let i = 0; i < Math.min(len, 32); i += 1) {
        preview.push(Number(typed[i] || 0));
      }
      return {
        kind: 'typed-array',
        length: len,
        preview,
      };
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeUnknown(entry);
    }
    return out;
  }

  return value;
}

function normalizeState(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return normalizeUnknown(input) as Record<string, unknown>;
}

function extractChangedKeys(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify(prev[key]);
    const b = JSON.stringify(next[key]);
    if (a !== b) {
      changed.push(key);
    }
  }
  return changed;
}

function classifyRole(type: string, group: string): 'board' | 'input' | 'output' | 'other' {
  if (isProgrammableBoardType(type)) return 'board';

  const g = String(group || '').toLowerCase();
  if (/(output|display|actuator|memory)/.test(g)) return 'output';
  if (/(sensor|input|basic|communication|logic)/.test(g)) return 'input';
  return 'other';
}

function compactStateForReport(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'string' && value.length > 220) {
      out[key] = `${value.slice(0, 220)}...`;
      continue;
    }

    if (value && typeof value === 'object') {
      const asObj = value as Record<string, unknown>;
      if (asObj.kind === 'array' || asObj.kind === 'typed-array') {
        out[key] = asObj;
        continue;
      }

      const encoded = JSON.stringify(value);
      if (encoded.length > 420) {
        out[key] = {
          kind: 'object',
          keys: Object.keys(asObj),
          size: encoded.length,
        };
        continue;
      }
    }

    out[key] = value;
  }
  return out;
}

function mergeStatus(
  current: 'ok' | 'warn' | 'error',
  next: 'ok' | 'warn' | 'error'
): 'ok' | 'warn' | 'error' {
  if (current === 'error' || next === 'error') return 'error';
  if (current === 'warn' || next === 'warn') return 'warn';
  return 'ok';
}

function formatTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') {
    const asRecord = value as Record<string, unknown>;
    if (asRecord.kind === 'array' || asRecord.kind === 'typed-array') {
      return String(asRecord.length || 0);
    }
  }
  return JSON.stringify(value);
}

function getPathValue(source: Record<string, unknown>, pathLike: string): unknown {
  const path = String(pathLike || '').trim();
  if (!path) return undefined;

  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  let current: unknown = source;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function renderTelemetryTemplate(
  template: string,
  ctx: { state: Record<string, unknown>; attr: Record<string, unknown> }
): string {
  return String(template || '').replace(/\$\{([^}]+)\}/g, (_m: string, expr: string) => {
    const key = String(expr || '').trim();
    if (!key) return '';

    if (key.startsWith('state.')) {
      return formatTemplateValue(getPathValue(ctx.state, key.slice('state.'.length)));
    }

    if (key.startsWith('attr.')) {
      return formatTemplateValue(getPathValue(ctx.attr, key.slice('attr.'.length)));
    }

    if (key === 'state') {
      return formatTemplateValue(ctx.state);
    }

    if (key === 'attr') {
      return formatTemplateValue(ctx.attr);
    }

    return formatTemplateValue(getPathValue(ctx.state, key));
  });
}

function summarizeOutputState(type: string, state: Record<string, unknown>, updates: number): string {
  const t = String(type || '').toLowerCase();

  if (t.includes('led')) {
    const lit = Boolean(state.illuminated ?? state.on ?? state.active ?? false);
    const brightness = Number(state.brightness ?? state.intensity ?? 0);
    return `LED ${lit ? 'ON' : 'OFF'} brightness=${Number.isFinite(brightness) ? brightness : 0}`;
  }

  if (t.includes('neopixel')) {
    const pixels = state.pixels as unknown;
    if (Array.isArray(pixels)) {
      return `Neopixel pixels=${pixels.length}`;
    }
    if (pixels && typeof pixels === 'object' && (pixels as Record<string, unknown>).kind === 'array') {
      const len = Number((pixels as Record<string, unknown>).length || 0);
      return `Neopixel pixels=${len}`;
    }
    return `Neopixel updates=${updates}`;
  }

  if (t.includes('motor') || t.includes('servo')) {
    const speed = Number(state.speed ?? state.rpm ?? state.velocity ?? 0);
    const angle = Number(state.angle ?? state.position ?? NaN);
    if (Number.isFinite(angle)) return `Motor/Servo speed=${speed} angle=${angle}`;
    return `Motor/Servo speed=${speed}`;
  }

  if (t.includes('ssd1306') || t.includes('lcd') || t.includes('ili9341') || t.includes('max7219') || t.includes('7segment')) {
    const text = typeof state.text === 'string'
      ? state.text
      : typeof state.value === 'string'
        ? state.value
        : '';
    if (text) {
      const oneLine = text.replace(/\s+/g, ' ').trim();
      return `Display text="${oneLine.slice(0, 80)}${oneLine.length > 80 ? '...' : ''}"`;
    }
    return `Display updates=${updates}`;
  }

  const keys = Object.keys(state);
  return keys.length ? `State keys: ${keys.slice(0, 8).join(', ')}` : `No observable output state`;
}

export class SimulationTelemetryCollector {
  private readonly project: OpenHwProject;
  private readonly boardIds: string[];
  private readonly componentMeta: Map<string, ComponentMeta>;

  private readonly boardPins = new Map<string, Record<string, boolean>>();
  private readonly boardFaults = new Map<string, number>();
  private readonly boardSerialChars = new Map<string, number>();

  private readonly componentStates = new Map<string, Record<string, unknown>>();
  private readonly componentUpdates = new Map<string, number>();
  private readonly componentChangedKeys = new Map<string, Set<string>>();
  private readonly componentTelemetrySummary = new Map<string, string>();
  private readonly componentTelemetryData = new Map<string, Record<string, unknown>>();

  private totalFaults = 0;
  private totalSerialChars = 0;

  private constructor(project: OpenHwProject, boardIds: string[], componentMeta: Map<string, ComponentMeta>) {
    this.project = project;
    this.boardIds = boardIds;
    this.componentMeta = componentMeta;
  }

  static async create(project: OpenHwProject, boardIds: string[]): Promise<SimulationTelemetryCollector> {
    const metaMap = new Map<string, ComponentMeta>();

    for (const component of project.components) {
      const info = await getManifestInfo(component.type);
      const group = info?.group || 'Other';
      metaMap.set(component.id, {
        id: component.id,
        type: component.type,
        label: String(component.label || component.id),
        group,
        role: classifyRole(component.type, group),
        hasOnEvent: !!info?.hasOnEvent,
        attrs:
          component.attrs && typeof component.attrs === 'object' && !Array.isArray(component.attrs)
            ? (component.attrs as Record<string, unknown>)
            : {},
        telemetryTemplate: typeof info?.telemetry?.template === 'string' ? info.telemetry.template : undefined,
        telemetryCriticalKeys: Array.isArray(info?.telemetry?.criticalKeys)
          ? info!.telemetry!.criticalKeys
          : [],
        x: Number.isFinite(Number(component.x)) ? Number(component.x) : 0,
        y: Number.isFinite(Number(component.y)) ? Number(component.y) : 0,
        w: Number.isFinite(Number(component.w)) ? Number(component.w) : 80,
        h: Number.isFinite(Number(component.h)) ? Number(component.h) : 80,
      });
    }

    return new SimulationTelemetryCollector(project, boardIds, metaMap);
  }

  onEvent(message: any): void {
    const type = String(message?.type || '');
    const boardId = String(message?.boardId || '');

    if (type === 'serial') {
      const chunk = String(message?.data || '');
      const len = chunk.length;
      this.totalSerialChars += len;
      if (boardId) {
        this.boardSerialChars.set(boardId, Number(this.boardSerialChars.get(boardId) || 0) + len);
      }
      return;
    }

    if (type === 'fault') {
      this.totalFaults += 1;
      if (boardId) {
        this.boardFaults.set(boardId, Number(this.boardFaults.get(boardId) || 0) + 1);
      }
      return;
    }

    if (type !== 'state') {
      return;
    }

    if (boardId && message?.pins && typeof message.pins === 'object') {
      const normalizedPins: Record<string, boolean> = {};
      for (const [pin, isHigh] of Object.entries(message.pins as Record<string, unknown>)) {
        normalizedPins[String(pin)] = !!isHigh;
      }
      this.boardPins.set(boardId, normalizedPins);
    }

    if (!Array.isArray(message?.components)) {
      return;
    }

    for (const comp of message.components as Array<{
      id?: string;
      state?: unknown;
      telemetrySummary?: unknown;
      telemetryData?: unknown;
    }>) {
      const compId = String(comp?.id || '');
      if (!compId) continue;

      const prev = this.componentStates.get(compId) || {};
      const next = normalizeState(comp?.state);
      const changed = extractChangedKeys(prev, next);

      this.componentStates.set(compId, next);
      this.componentUpdates.set(compId, Number(this.componentUpdates.get(compId) || 0) + 1);

      if (!this.componentChangedKeys.has(compId)) {
        this.componentChangedKeys.set(compId, new Set<string>());
      }
      const keySet = this.componentChangedKeys.get(compId)!;
      for (const key of changed) {
        keySet.add(key);
      }

      if (typeof comp.telemetrySummary === 'string' && comp.telemetrySummary.trim()) {
        this.componentTelemetrySummary.set(compId, comp.telemetrySummary.trim());
      }

      if (comp.telemetryData && typeof comp.telemetryData === 'object' && !Array.isArray(comp.telemetryData)) {
        this.componentTelemetryData.set(compId, normalizeState(comp.telemetryData));
      }
    }
  }

  getSnapshot(): SimulationSnapshot {
    const components: SimulationComponentSnapshot[] = this.project.components.map((component) => {
      const meta = this.componentMeta.get(component.id);
      return {
        id: component.id,
        type: component.type,
        label: meta?.label || component.id,
        group: meta?.group || 'Other',
        x: meta?.x ?? 0,
        y: meta?.y ?? 0,
        w: meta?.w ?? 80,
        h: meta?.h ?? 80,
        state: compactStateForReport(this.componentStates.get(component.id) || {}),
      };
    });

    const pinsByBoard: Record<string, Record<string, boolean>> = {};
    for (const boardId of this.boardIds) {
      pinsByBoard[boardId] = this.boardPins.get(boardId) || {};
    }

    return {
      capturedAt: new Date().toISOString(),
      boards: this.boardIds.map((id) => {
        const comp = this.project.components.find((c) => c.id === id);
        return {
          id,
          type: comp?.type || 'unknown',
        };
      }),
      pinsByBoard,
      components,
      connections: this.project.connections,
    };
  }

  getReport(elapsedMs: number): SimulationTelemetryReport {
    const components: SimulationComponentTelemetry[] = [];

    for (const [componentId, meta] of this.componentMeta.entries()) {
      const updates = Number(this.componentUpdates.get(componentId) || 0);
      const changedKeys = [...(this.componentChangedKeys.get(componentId) || new Set<string>())].sort((a, b) =>
        a.localeCompare(b)
      );
      const state = compactStateForReport(this.componentStates.get(componentId) || {});
      const telemetryData = compactStateForReport(this.componentTelemetryData.get(componentId) || {});
      const decentralizedSummary = String(this.componentTelemetrySummary.get(componentId) || '').trim();
      const notes: string[] = [];

      let status: 'ok' | 'warn' | 'error' = 'ok';

      const asRecord = state as Record<string, unknown>;
      if (asRecord.burnedOut === true || asRecord.error === true || asRecord.fault === true) {
        status = 'error';
        notes.push('Component reported error/fault state.');
      }

      const heuristics = (telemetryData._heuristics && typeof telemetryData._heuristics === 'object')
        ? (telemetryData._heuristics as Record<string, unknown>)
        : null;
      const heuristicStatus = String(heuristics?.status || '').toLowerCase();
      if (heuristicStatus === 'error' || heuristicStatus === 'warn') {
        status = mergeStatus(status, heuristicStatus as 'warn' | 'error');
      }

      if (Array.isArray(heuristics?.findings) && (heuristics?.findings as unknown[]).length > 0) {
        for (const finding of heuristics!.findings as unknown[]) {
          const text = String(finding || '').trim();
          if (text) notes.push(text);
        }
      }

      const criticalKeys = Array.isArray(meta.telemetryCriticalKeys) ? meta.telemetryCriticalKeys : [];
      for (const key of criticalKeys) {
        const lookup = String(key || '').trim();
        if (!lookup) continue;

        let value: unknown;
        if (lookup.startsWith('state.')) {
          value = getPathValue(state, lookup.slice('state.'.length));
        } else if (lookup.startsWith('attr.')) {
          value = getPathValue(meta.attrs, lookup.slice('attr.'.length));
        } else {
          value = getPathValue(state, lookup);
        }

        if (value === undefined) {
          status = mergeStatus(status, 'warn');
          notes.push(`Critical telemetry key missing: ${lookup}`);
        }
      }

      if (meta.role === 'board') {
        const boardFaults = Number(this.boardFaults.get(componentId) || 0);
        if (boardFaults > 0) {
          status = 'error';
          notes.push(`Runtime faults observed: ${boardFaults}`);
        }
      }

      if (updates === 0) {
        if (meta.role === 'output') {
          status = status === 'error' ? 'error' : 'warn';
          notes.push('No output-state updates observed during run.');
        } else if (meta.role === 'input' && meta.hasOnEvent) {
          status = status === 'error' ? 'error' : 'warn';
          notes.push('Interactive input component did not receive/emit state changes.');
        } else {
          notes.push('No runtime state updates observed.');
        }
      }

      const templatedSummary = meta.telemetryTemplate
        ? renderTelemetryTemplate(meta.telemetryTemplate, { state, attr: meta.attrs })
        : '';
      const outputSummary = decentralizedSummary || templatedSummary || summarizeOutputState(meta.type, state, updates);

      const universalMetrics = telemetryData._metrics && typeof telemetryData._metrics === 'object'
        ? (telemetryData._metrics as Record<string, unknown>)
        : undefined;

      components.push({
        id: componentId,
        type: meta.type,
        label: meta.label,
        group: meta.group,
        role: meta.role,
        status,
        updates,
        changedKeys,
        outputSummary,
        telemetrySummary: outputSummary,
        telemetryData,
        universalMetrics,
        notes,
        lastState: state,
      });
    }

    const boards = this.boardIds.map((boardId) => {
      const meta = this.componentMeta.get(boardId);
      return {
        id: boardId,
        type: meta?.type || 'unknown',
        serialChars: Number(this.boardSerialChars.get(boardId) || 0),
        faultCount: Number(this.boardFaults.get(boardId) || 0),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      elapsedMs,
      faults: this.totalFaults,
      serialChars: this.totalSerialChars,
      boards,
      components: components.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
}
