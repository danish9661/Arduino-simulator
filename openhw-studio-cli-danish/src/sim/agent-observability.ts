import type { OpenHwProject, SimulationSnapshot, SimulationTelemetryReport } from '../types.js';
import type { ManifestInfo } from '../utils/manifests.js';

export type ComponentInputTemplate = string | Record<string, unknown>;

export type ComponentInputSchema = {
  id: string;
  type: string;
  label: string;
  group: string;
  role: 'board' | 'input' | 'output' | 'other';
  interactive: boolean;
  hasOnEvent: boolean;
  templates: ComponentInputTemplate[];
  profiles: Array<{
    name: string;
    description: string;
    defaultDurationMs: number;
    example: Array<{ atMs: number; event: unknown }>;
  }>;
};

export type DisplayStateView = {
  id: string;
  type: string;
  label: string;
  text: string | null;
  value: number | string | null;
  segments: unknown;
  pixels: unknown;
  rawState: Record<string, unknown>;
};

export type BoardPinState = {
  boardId: string;
  type: string;
  pins: Array<{ pin: string; high: boolean }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function classifyRole(type: string, group: string): 'board' | 'input' | 'output' | 'other' {
  if (/(arduino|esp32|stm32|rp2040|pico)/i.test(type)) return 'board';
  const g = String(group || '').toLowerCase();
  if (/(output|display|actuator|memory)/.test(g)) return 'output';
  if (/(sensor|input|basic|communication|logic)/.test(g)) return 'input';
  return 'other';
}

export function interactionTemplatesForType(type: string): ComponentInputTemplate[] {
  const t = String(type || '').toLowerCase();

  if (t.includes('pushbutton')) return ['press', 'release'];
  if (t.includes('potentiometer') || t.includes('slide-potentiometer')) {
    return [{ type: 'input', value: 0 }, { type: 'input', value: 50 }, { type: 'input', value: 100 }];
  }
  if (t.includes('ldr')) {
    return [
      { type: 'SET_ATTR', key: 'lux', value: 100 },
      { type: 'SET_ATTR', key: 'lux', value: 800 },
      { type: 'SET_ATTR', key: 'threshold', value: 500 },
    ];
  }
  if (t.includes('max30102')) {
    return [{ type: 'SET_ATTR', key: 'heartRate', value: 75 }, { type: 'SET_ATTR', key: 'spo2', value: 98 }];
  }
  if (t.includes('dht')) {
    return [
      { type: 'SET_ATTR', key: 'temperature', value: 24 },
      { type: 'SET_ATTR', key: 'humidity', value: 60 },
    ];
  }
  return [{ type: 'input', value: 50 }, { type: 'SET_ATTR', key: 'value', value: 50 }];
}

export function sensorProfilesForType(type: string): ComponentInputSchema['profiles'] {
  const t = String(type || '').toLowerCase();

  if (t.includes('pushbutton')) {
    return [
      {
        name: 'button_bounce',
        description: 'Press/release burst that simulates switch bounce.',
        defaultDurationMs: 250,
        example: [
          { atMs: 10, event: 'press' },
          { atMs: 40, event: 'release' },
          { atMs: 65, event: 'press' },
          { atMs: 95, event: 'release' },
          { atMs: 130, event: 'press' },
        ],
      },
    ];
  }

  if (t.includes('potentiometer')) {
    return [
      {
        name: 'pot_ramp',
        description: 'Sweep potentiometer input from low to high.',
        defaultDurationMs: 900,
        example: [
          { atMs: 50, event: { type: 'input', value: 0 } },
          { atMs: 350, event: { type: 'input', value: 50 } },
          { atMs: 700, event: { type: 'input', value: 100 } },
        ],
      },
    ];
  }

  if (t.includes('ldr') || t.includes('light')) {
    return [
      {
        name: 'light_sweep',
        description: 'Change light intensity from dark to bright.',
        defaultDurationMs: 1000,
        example: [
          { atMs: 50, event: { type: 'SET_ATTR', key: 'lux', value: 80 } },
          { atMs: 450, event: { type: 'SET_ATTR', key: 'lux', value: 450 } },
          { atMs: 850, event: { type: 'SET_ATTR', key: 'lux', value: 900 } },
        ],
      },
      {
        name: 'light_noise',
        description: 'Inject noisy light readings around a threshold.',
        defaultDurationMs: 1000,
        example: [
          { atMs: 100, event: { type: 'SET_ATTR', key: 'lux', value: 480 } },
          { atMs: 240, event: { type: 'SET_ATTR', key: 'lux', value: 510 } },
          { atMs: 420, event: { type: 'SET_ATTR', key: 'lux', value: 495 } },
          { atMs: 610, event: { type: 'SET_ATTR', key: 'lux', value: 520 } },
        ],
      },
    ];
  }

  if (t.includes('max30102')) {
    return [
      {
        name: 'heart_rate_ramp',
        description: 'Ramp heart rate and SpO2 readings.',
        defaultDurationMs: 1200,
        example: [
          { atMs: 100, event: { type: 'SET_ATTR', key: 'heartRate', value: 68 } },
          { atMs: 500, event: { type: 'SET_ATTR', key: 'heartRate', value: 88 } },
          { atMs: 900, event: { type: 'SET_ATTR', key: 'spo2', value: 97 } },
        ],
      },
    ];
  }

  return [];
}

export function componentInputSchemaForProject(
  project: OpenHwProject,
  manifestByType: Map<string, ManifestInfo | null>
): ComponentInputSchema[] {
  return project.components.map((component) => {
    const manifest = manifestByType.get(component.type) || null;
    const group = manifest?.group || 'Other';
    const role = classifyRole(component.type, group);
    const templates = interactionTemplatesForType(component.type);
    const profiles = sensorProfilesForType(component.type);

    return {
      id: component.id,
      type: component.type,
      label: String(component.label || component.id),
      group,
      role,
      interactive: !!manifest?.hasOnEvent || templates.length > 0,
      hasOnEvent: !!manifest?.hasOnEvent,
      templates,
      profiles,
    };
  });
}

function looksLikeDisplay(type: string, state: Record<string, unknown>): boolean {
  const t = String(type || '').toLowerCase();
  if (/(display|oled|lcd|ssd1306|ili9341|max7219|7segment|segment|matrix|tm1637)/.test(t)) return true;
  return ['text', 'segments', 'pixels', 'chars', 'buffer'].some((key) => Object.prototype.hasOwnProperty.call(state, key));
}

export function extractDisplayStates(
  snapshot: SimulationSnapshot,
  telemetry?: SimulationTelemetryReport | null
): DisplayStateView[] {
  const telemetryById = new Map(
    Array.isArray(telemetry?.components)
      ? telemetry!.components.map((entry) => [String(entry.id), entry])
      : []
  );

  return snapshot.components
    .filter((component) => looksLikeDisplay(component.type, component.state || {}))
    .map((component) => {
      const state = asRecord(component.state) || {};
      const telemetryEntry = telemetryById.get(component.id);
      const telemetryData = asRecord(telemetryEntry?.telemetryData);
      const text = typeof state.text === 'string'
        ? state.text
        : typeof state.value === 'string'
          ? state.value
          : (typeof telemetryEntry?.outputSummary === 'string' ? telemetryEntry.outputSummary : null);

      const numeric = typeof state.value === 'number'
        ? state.value
        : (typeof state.number === 'number' ? state.number : null);

      return {
        id: component.id,
        type: component.type,
        label: component.label,
        text,
        value: numeric ?? (typeof state.value === 'string' ? state.value : null),
        segments: state.segments ?? telemetryData?.segments ?? null,
        pixels: state.pixels ?? telemetryData?.pixels ?? state.buffer ?? null,
        rawState: state,
      };
    });
}

export function normalizeBoardPinStates(snapshot: SimulationSnapshot): BoardPinState[] {
  return snapshot.boards.map((board) => {
    const pins = snapshot.pinsByBoard[board.id] || {};
    const normalizedPins = Object.keys(pins)
      .sort((a, b) => a.localeCompare(b))
      .map((pin) => ({ pin, high: !!pins[pin] }));

    return {
      boardId: board.id,
      type: board.type,
      pins: normalizedPins,
    };
  });
}

export function diffBoardPins(
  before: SimulationSnapshot,
  after: SimulationSnapshot
): Array<{ boardId: string; changedPins: Array<{ pin: string; before: boolean; after: boolean }> }> {
  const boardIds = new Set<string>([
    ...Object.keys(before.pinsByBoard || {}),
    ...Object.keys(after.pinsByBoard || {}),
  ]);

  const diffs: Array<{ boardId: string; changedPins: Array<{ pin: string; before: boolean; after: boolean }> }> = [];
  for (const boardId of boardIds) {
    const beforePins = before.pinsByBoard[boardId] || {};
    const afterPins = after.pinsByBoard[boardId] || {};
    const pinIds = new Set<string>([...Object.keys(beforePins), ...Object.keys(afterPins)]);
    const changedPins: Array<{ pin: string; before: boolean; after: boolean }> = [];

    for (const pinId of pinIds) {
      const a = !!beforePins[pinId];
      const b = !!afterPins[pinId];
      if (a !== b) {
        changedPins.push({ pin: pinId, before: a, after: b });
      }
    }

    if (changedPins.length > 0) {
      changedPins.sort((x, y) => x.pin.localeCompare(y.pin));
      diffs.push({ boardId, changedPins });
    }
  }

  return diffs.sort((a, b) => a.boardId.localeCompare(b.boardId));
}

export function diffComponentStates(
  before: SimulationSnapshot,
  after: SimulationSnapshot,
  componentId?: string | null
): Array<{ id: string; changedKeys: string[]; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const beforeById = new Map(before.components.map((entry) => [entry.id, asRecord(entry.state) || {}]));
  const afterById = new Map(after.components.map((entry) => [entry.id, asRecord(entry.state) || {}]));

  const ids = componentId
    ? [componentId]
    : [...new Set<string>([...beforeById.keys(), ...afterById.keys()])].sort((a, b) => a.localeCompare(b));

  const diffs: Array<{ id: string; changedKeys: string[]; before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  const equals = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    const leftIsObject = left !== null && typeof left === 'object';
    const rightIsObject = right !== null && typeof right === 'object';
    if (!leftIsObject || !rightIsObject) return false;
    return JSON.stringify(left) === JSON.stringify(right);
  };

  for (const id of ids) {
    const b = beforeById.get(id) || {};
    const a = afterById.get(id) || {};
    const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
    const changed = [...keys]
      .filter((key) => !equals((b as Record<string, unknown>)[key], (a as Record<string, unknown>)[key]))
      .sort((x, y) => x.localeCompare(y));
    if (changed.length > 0) {
      diffs.push({ id, changedKeys: changed, before: b, after: a });
    }
  }

  return diffs;
}

export function buildProfileEvents(
  profile: string,
  componentType: string,
  durationMs: number
): Array<{ atMs: number; event: unknown }> {
  const profileSpec = sensorProfilesForType(componentType).find((entry) => entry.name === profile);
  if (!profileSpec) return [];
  const base = Math.max(1, profileSpec.defaultDurationMs);
  const scale = Math.max(0.05, durationMs / base);
  return profileSpec.example.map((entry) => ({
    atMs: Math.max(0, Math.min(durationMs, Math.floor(entry.atMs * scale))),
    event: entry.event,
  }));
}

export type AssertionCheck =
  | { type: 'display_contains'; component_id?: string; text: string }
  | { type: 'component_status'; component_id: string; status: 'ok' | 'warn' | 'error' }
  | { type: 'pin_state'; board_id: string; pin: string; high: boolean };

export function evaluateAssertions(input: {
  checks: AssertionCheck[];
  displays: DisplayStateView[];
  telemetry: SimulationTelemetryReport | null;
  snapshot: SimulationSnapshot;
}): {
  ok: boolean;
  total: number;
  passed: number;
  results: Array<{ check: AssertionCheck; ok: boolean; actual: unknown }>;
} {
  const results = input.checks.map((check) => {
    if (check.type === 'display_contains') {
      const displays = check.component_id
        ? input.displays.filter((entry) => entry.id === check.component_id)
        : input.displays;
      const haystack = displays.map((entry) => String(entry.text || '')).join('\n');
      const ok = haystack.toLowerCase().includes(String(check.text || '').toLowerCase());
      return {
        check,
        ok,
        actual: {
          componentIds: displays.map((entry) => entry.id),
          text: haystack,
        },
      };
    }

    if (check.type === 'component_status') {
      const component = input.telemetry?.components.find((entry) => entry.id === check.component_id) || null;
      const actual = component?.status || 'missing';
      return {
        check,
        ok: actual === check.status,
        actual,
      };
    }

    const pinValue = !!(input.snapshot.pinsByBoard?.[check.board_id]?.[check.pin]);
    return {
      check,
      ok: pinValue === !!check.high,
      actual: pinValue,
    };
  });

  const passed = results.filter((entry) => entry.ok).length;
  return {
    ok: passed === results.length,
    total: results.length,
    passed,
    results,
  };
}
