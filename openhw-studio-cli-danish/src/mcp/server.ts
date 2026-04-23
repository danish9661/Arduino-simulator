import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { OpenHwProject, SimulationRunOptions } from '../types.js';
import {
  addComponent,
  addConnection,
  createProject,
  loadProject,
  saveProject,
  summarizeProject,
  validateProject,
} from '../utils/project.js';
import { relToCwd, resolveWorkspacePath } from '../utils/paths.js';
import { startSimulation } from '../sim/session.js';
import { getManifestInfo, getPinsForType, listManifestInfos } from '../utils/manifests.js';
import {
  buildProfileEvents,
  componentInputSchemaForProject,
  diffBoardPins,
  diffComponentStates,
  evaluateAssertions,
  extractDisplayStates,
  normalizeBoardPinStates,
} from '../sim/agent-observability.js';

export interface McpServerConfig {
  backendUrl: string;
  authToken?: string;
}

type ActiveProjectSession = {
  projectFile: string | null;
};

type McpTraceEvent = {
  tMs: number;
  boardId: string;
  type: string;
  detail: Record<string, unknown>;
};

type TraceBuildOptions = {
  includeState: boolean;
  includeSerialText: boolean;
  maxSerialChars: number;
  componentId: string | null;
};

type RuntimeCaptureOptions = {
  includeTrace: boolean;
  includeConsole: boolean;
  maxEvents: number;
  maxConsoleChars: number;
  traceEventTypes: string[];
  traceBuild: TraceBuildOptions;
};

type RuntimeCaptureResult = {
  trace: McpTraceEvent[];
  droppedTraceEvents: number;
  consoleText: string;
};

function normalizeTraceEventTypes(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function clampPositiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  if (normalized < min) return fallback;
  return Math.min(normalized, max);
}

function compactTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 220 ? `${value.slice(0, 220)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (ArrayBuffer.isView(value)) {
    const typed = value as unknown as { length?: number; [k: number]: number };
    const len = Number(typed.length || 0);
    const preview: number[] = [];
    for (let i = 0; i < Math.min(len, 24); i += 1) {
      preview.push(Number(typed[i] || 0));
    }

    return {
      kind: 'typed-array',
      length: len,
      preview,
    };
  }

  if (Array.isArray(value)) {
    if (depth >= 2 || value.length > 16) {
      return {
        kind: 'array',
        length: value.length,
        preview: value.slice(0, 8).map((entry) => compactTraceValue(entry, depth + 1)),
      };
    }
    return value.map((entry) => compactTraceValue(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const asRecord = value as Record<string, unknown>;
    const keys = Object.keys(asRecord).sort((a, b) => a.localeCompare(b));

    if (depth >= 2 || keys.length > 20) {
      return {
        kind: 'object',
        keys: keys.slice(0, 20),
        size: keys.length,
      };
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = compactTraceValue(asRecord[key], depth + 1);
    }
    return out;
  }

  return String(value);
}

function buildTraceEvent(
  message: any,
  startedAtMs: number,
  options: TraceBuildOptions
): McpTraceEvent | null {
  const type = String(message?.type || '').trim() || 'unknown';
  const boardId = String(message?.boardId || 'default').trim() || 'default';
  const tMs = Math.max(0, Date.now() - startedAtMs);

  if (type === 'serial') {
    const chunk = String(message?.data || '');
    const detail: Record<string, unknown> = {
      source: String(message?.source || 'uart0'),
      length: chunk.length,
    };

    if (Number.isFinite(Number(message?.value))) {
      detail.value = Number(message.value);
    }

    if (options.includeSerialText) {
      detail.data = chunk.length > options.maxSerialChars
        ? `${chunk.slice(0, options.maxSerialChars)}...`
        : chunk;
    }

    return { tMs, boardId, type, detail };
  }

  if (type === 'state') {
    const detail: Record<string, unknown> = {};

    if (message?.pins && typeof message.pins === 'object') {
      const pinKeys = Object.keys(message.pins as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
      if (pinKeys.length > 0) {
        detail.pinKeys = pinKeys;
      }
    }

    if (Object.prototype.hasOwnProperty.call(message || {}, 'analog')) {
      detail.analog = options.includeState
        ? compactTraceValue(message.analog)
        : (Array.isArray(message.analog)
          ? { kind: 'array', length: message.analog.length }
          : typeof message.analog);
    }

    if (Array.isArray(message?.components)) {
      const components = (message.components as Array<Record<string, unknown>>)
        .map((component) => {
          const id = String(component?.id || '').trim();
          if (!id) return null;
          if (options.componentId && id !== options.componentId) return null;

          const state =
            component?.state && typeof component.state === 'object' && !Array.isArray(component.state)
              ? (component.state as Record<string, unknown>)
              : {};

          const entry: Record<string, unknown> = {
            id,
            stateKeys: Object.keys(state).sort((a, b) => a.localeCompare(b)),
          };

          if (typeof component?.telemetrySummary === 'string' && component.telemetrySummary.trim()) {
            entry.telemetrySummary = component.telemetrySummary.trim();
          }

          if (options.includeState) {
            entry.state = compactTraceValue(state);
            if (component?.telemetryData && typeof component.telemetryData === 'object') {
              entry.telemetryData = compactTraceValue(component.telemetryData);
            }
          }

          return entry;
        })
        .filter((entry): entry is Record<string, unknown> => !!entry);

      if (components.length > 0) {
        detail.components = components;
      }
    }

    if (Object.keys(detail).length === 0) {
      return null;
    }

    return { tMs, boardId, type, detail };
  }

  if (type === 'fault') {
    return {
      tMs,
      boardId,
      type,
      detail: {
        reason: String(message?.reason || 'runtime fault'),
        pc: message?.pc ?? null,
      },
    };
  }

  if (type === 'debug') {
    const detail: Record<string, unknown> = {
      category: String(message?.category || ''),
      reason: String(message?.reason || ''),
    };

    if (message?.metrics && typeof message.metrics === 'object') {
      detail.metrics = compactTraceValue(message.metrics);
    }
    if (message?.gdb && typeof message.gdb === 'object') {
      detail.gdb = compactTraceValue(message.gdb);
    }
    if (message?.wireless && typeof message.wireless === 'object') {
      detail.wireless = compactTraceValue(message.wireless);
    }

    return { tMs, boardId, type, detail };
  }

  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message || {})) {
    if (key === 'type' || key === 'boardId') continue;
    detail[key] = compactTraceValue(value);
  }

  if (Object.keys(detail).length === 0) {
    return null;
  }

  return { tMs, boardId, type, detail };
}

function createRuntimeCapture(options: RuntimeCaptureOptions) {
  const includeTrace = !!options.includeTrace;
  const includeConsole = !!options.includeConsole;
  const maxEvents = Math.max(1, clampPositiveInt(options.maxEvents, 300, 1, 5000));
  const maxConsoleChars = Math.max(256, clampPositiveInt(options.maxConsoleChars, 8000, 256, 250000));
  const traceEventTypes = normalizeTraceEventTypes(options.traceEventTypes);
  const traceTypeFilter = traceEventTypes.length > 0 ? new Set(traceEventTypes) : null;
  const traceBuildOptions: TraceBuildOptions = {
    includeState: !!options.traceBuild.includeState,
    includeSerialText: !!options.traceBuild.includeSerialText,
    maxSerialChars: Math.max(16, clampPositiveInt(options.traceBuild.maxSerialChars, 120, 16, 10000)),
    componentId: String(options.traceBuild.componentId || '').trim() || null,
  };

  const startedAtMs = Date.now();
  const trace: McpTraceEvent[] = [];
  let droppedTraceEvents = 0;
  let consoleText = '';

  const onEvent = (message: any) => {
    const type = String(message?.type || '').trim().toLowerCase();

    if (includeConsole && type === 'serial') {
      const chunk = String(message?.data || '');
      if (chunk) {
        consoleText = `${consoleText}${chunk}`;
        if (consoleText.length > maxConsoleChars) {
          consoleText = consoleText.slice(consoleText.length - maxConsoleChars);
        }
      }
    }

    if (!includeTrace) return;
    if (traceTypeFilter && !traceTypeFilter.has(type)) {
      return;
    }

    const traceEvent = buildTraceEvent(message, startedAtMs, traceBuildOptions);
    if (!traceEvent) return;

    if (trace.length >= maxEvents) {
      droppedTraceEvents += 1;
      return;
    }

    trace.push(traceEvent);
  };

  const flush = (): RuntimeCaptureResult => ({
    trace,
    droppedTraceEvents,
    consoleText,
  });

  return {
    onEvent,
    flush,
  };
}

function toSafeSlug(input: string): string {
  const base = String(input || 'project')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'project';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function parseLooseValue(input: unknown): unknown {
  if (typeof input !== 'string') return input;

  const trimmed = input.trim();
  if (!trimmed.length) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;

  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function makeToolResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function assertToken(config: McpServerConfig, providedToken?: string): void {
  const expected = String(config.authToken || '').trim();
  if (!expected) return;
  if (String(providedToken || '').trim() !== expected) {
    throw new Error('Unauthorized MCP tool call: invalid token.');
  }
}

async function requireActiveProject(session: ActiveProjectSession): Promise<{ projectFile: string; project: OpenHwProject }> {
  if (!session.projectFile) {
    throw new Error('No active project session. Call project_init first.');
  }

  const project = await loadProject(session.projectFile);
  return {
    projectFile: session.projectFile,
    project,
  };
}

function parseWireEndpoint(endpoint: string): { componentId: string; pinId: string } {
  const [componentId, pinId] = String(endpoint || '').split(':');
  if (!componentId || !pinId) {
    throw new Error(`Invalid endpoint format: ${endpoint}. Expected <componentId>:<pinId>.`);
  }
  return { componentId, pinId };
}

async function validateConnectionInProject(project: OpenHwProject, from: string, to: string): Promise<{
  from: string;
  to: string;
  valid: boolean;
  issues: string[];
}> {
  const issues: string[] = [];
  const endpoints = [from, to];

  for (const endpoint of endpoints) {
    let parsed: { componentId: string; pinId: string };
    try {
      parsed = parseWireEndpoint(endpoint);
    } catch (error) {
      const asError = error as { name?: string; code?: string; message?: string };
      const errorName = String(asError?.name || 'Error');
      const errorCode = String(asError?.code || '').trim();
      const errorMessage = String(asError?.message || error || 'Unknown error');
      issues.push(errorCode ? `${errorName}(${errorCode}): ${errorMessage}` : `${errorName}: ${errorMessage}`);
      continue;
    }

    const component = project.components.find((entry) => entry.id === parsed.componentId) || null;
    if (!component) {
      issues.push(`Component not found for endpoint: ${endpoint}`);
      continue;
    }

    const pins = await getPinsForType(component.type);
    if (pins && pins.size > 0 && !pins.has(parsed.pinId)) {
      issues.push(`Pin ${parsed.pinId} does not exist on component type ${component.type}.`);
    }
  }

  return {
    from,
    to,
    valid: issues.length === 0,
    issues,
  };
}

function buildInteractionEvent(event: unknown, value: unknown): unknown {
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    return event;
  }

  const eventName = String(event || '').trim();
  if (!eventName) {
    throw new Error('component_interact requires a non-empty event value.');
  }

  if (value === undefined) {
    if (eventName === 'press' || eventName === 'release') {
      return eventName;
    }
    return { type: eventName };
  }

  return {
    type: eventName,
    value: parseLooseValue(value),
  };
}

function buildCorrelationId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

function normalizeInputEventsForStep(options: {
  project: OpenHwProject;
  durationMs: number;
  inputs: Array<{
    id?: string;
    event?: unknown;
    value?: unknown;
    at_ms?: number;
    profile?: string;
  }>;
}): Array<{ atMs: number; id: string; event: unknown; profile?: string }> {
  const events: Array<{ atMs: number; id: string; event: unknown; profile?: string }> = [];

  for (const input of options.inputs) {
    const id = String(input?.id || '').trim();
    if (!id) continue;
    const component = options.project.components.find((entry) => entry.id === id) || null;
    if (!component) continue;

    const atMs = Math.max(0, Math.min(options.durationMs, Math.floor(Number(input?.at_ms || 0))));
    const profile = String(input?.profile || '').trim();
    if (profile) {
      for (const profileEvent of buildProfileEvents(profile, component.type, options.durationMs)) {
        events.push({
          atMs: profileEvent.atMs,
          id,
          event: profileEvent.event,
          profile,
        });
      }
      continue;
    }

    events.push({
      atMs,
      id,
      event: buildInteractionEvent(input?.event, input?.value),
    });
  }

  return events.sort((a, b) => a.atMs - b.atMs);
}

async function runSimulationForDuration(
  project: OpenHwProject,
  options: SimulationRunOptions,
  includeTelemetry: boolean,
  captureOptions: RuntimeCaptureOptions = {
    includeTrace: false,
    includeConsole: false,
    maxEvents: 300,
    maxConsoleChars: 8000,
    traceEventTypes: [],
    traceBuild: {
      includeState: false,
      includeSerialText: false,
      maxSerialChars: 120,
      componentId: null,
    },
  }
): Promise<{
  result: ReturnType<Awaited<ReturnType<typeof startSimulation>>['getResult']>;
  telemetry: ReturnType<Awaited<ReturnType<typeof startSimulation>>['getTelemetryReport']> | null;
  trace: McpTraceEvent[];
  droppedTraceEvents: number;
  consoleText: string;
}> {
  const runtimeCapture = createRuntimeCapture(captureOptions);
  const controller = await startSimulation(project, options, {
    suppressConsoleOutput: true,
    onEvent: runtimeCapture.onEvent,
  });
  const durationMs = Math.max(0, Number(options.durationMs || 0));
  if (durationMs > 0) {
    await sleep(durationMs);
  }
  controller.stop();

  const result = controller.getResult();
  const telemetry = includeTelemetry ? controller.getTelemetryReport() : null;
  if (telemetry) {
    result.telemetry = telemetry;
  }

  const capture = runtimeCapture.flush();

  return {
    result,
    telemetry,
    trace: capture.trace,
    droppedTraceEvents: capture.droppedTraceEvents,
    consoleText: capture.consoleText,
  };
}

export async function runMcpServer(config: McpServerConfig): Promise<void> {
  const session: ActiveProjectSession = {
    projectFile: null,
  };

  const server = new McpServer({
    name: 'openhw-studio-cli-danish',
    version: '0.1.0',
  });

  server.tool(
    'project_open',
    'Load an existing OpenHW project JSON and set it as active session project.',
    {
      file: z.string().min(1),
      token: z.string().optional(),
    },
    async ({ file, token }) => {
      assertToken(config, token);

      const projectFile = resolveWorkspacePath(String(file));
      const project = await loadProject(projectFile);
      session.projectFile = projectFile;

      return makeToolResult({
        ok: true,
        action: 'project_open',
        file: relToCwd(projectFile),
        summary: summarizeProject(project),
      });
    }
  );

  server.tool(
    'project_status',
    'Return current MCP active project session status.',
    {
      token: z.string().optional(),
    },
    async ({ token }) => {
      assertToken(config, token);

      if (!session.projectFile) {
        return makeToolResult({
          ok: true,
          action: 'project_status',
          active: false,
          file: null,
        });
      }

      const project = await loadProject(session.projectFile);
      return makeToolResult({
        ok: true,
        action: 'project_status',
        active: true,
        file: relToCwd(session.projectFile),
        summary: summarizeProject(project),
      });
    }
  );

  server.tool(
    'project_validate',
    'Validate active project schema and references.',
    {
      token: z.string().optional(),
    },
    async ({ token }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const validation = await validateProject(project);
      return makeToolResult({
        ok: validation.valid,
        action: 'project_validate',
        file: relToCwd(projectFile),
        ...validation,
      });
    }
  );

  server.tool(
    'component_catalog',
    'List known component manifest capabilities (pins, group, onEvent, telemetry keys).',
    {
      token: z.string().optional(),
    },
    async ({ token }) => {
      assertToken(config, token);
      const manifests = await listManifestInfos();
      return makeToolResult({
        ok: true,
        action: 'component_catalog',
        count: manifests.length,
        components: manifests.map((entry) => ({
          type: entry.type,
          label: entry.label,
          group: entry.group,
          pins: entry.pins.map((pin) => pin.id),
          hasOnEvent: entry.hasOnEvent,
          telemetry: entry.telemetry || null,
        })),
      });
    }
  );

  server.tool(
    'wiring_validate',
    'Validate one or more proposed wires against the active project without mutating it.',
    {
      from: z.string().optional(),
      to: z.string().optional(),
      wires: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).optional(),
      token: z.string().optional(),
    },
    async ({ from, to, wires, token }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const plannedWires = Array.isArray(wires) && wires.length > 0
        ? wires.map((entry) => ({ from: String(entry.from), to: String(entry.to) }))
        : [{
          from: String(from || ''),
          to: String(to || ''),
        }];

      if (plannedWires.some((entry) => !entry.from || !entry.to)) {
        throw new Error('wiring_validate requires either from/to fields or a non-empty wires[] array.');
      }

      const diagnostics = await Promise.all(
        plannedWires.map((entry) => validateConnectionInProject(project, entry.from, entry.to))
      );
      const valid = diagnostics.every((entry) => entry.valid);

      return makeToolResult({
        ok: valid,
        action: 'wiring_validate',
        file: relToCwd(projectFile),
        valid,
        diagnostics,
      });
    }
  );

  server.tool(
    'simulation_capabilities',
    'Describe simulation observability/input/assertion capabilities for the active project.',
    {
      token: z.string().optional(),
    },
    async ({ token }) => {
      assertToken(config, token);
      const { project, projectFile } = await requireActiveProject(session);

      const manifestByType = new Map<string, Awaited<ReturnType<typeof getManifestInfo>>>();
      for (const component of project.components) {
        if (!manifestByType.has(component.type)) {
          manifestByType.set(component.type, await getManifestInfo(component.type));
        }
      }

      const componentSchemas = componentInputSchemaForProject(project, manifestByType);
      return makeToolResult({
        ok: true,
        action: 'simulation_capabilities',
        file: relToCwd(projectFile),
        tools: {
          observability: ['sim_execute', 'sim_trace', 'sim_inspect'],
          interaction: ['component_interact', 'simulation_step'],
          assertions: ['simulation_assert'],
          metadata: ['component_catalog', 'component_input_schema'],
        },
        project: {
          boards: project.components.filter((entry) => /(arduino|esp32|stm32|rp2040|pico)/i.test(entry.type)).map((entry) => ({
            id: entry.id,
            type: entry.type,
            label: entry.label || entry.id,
          })),
          interactiveComponents: componentSchemas.filter((entry) => entry.interactive).map((entry) => ({
            id: entry.id,
            type: entry.type,
            role: entry.role,
            profiles: entry.profiles.map((profile) => profile.name),
          })),
        },
      });
    }
  );

  server.tool(
    'component_input_schema',
    'Return supported input payload templates, profiles, and event hints per project component.',
    {
      id: z.string().optional(),
      token: z.string().optional(),
    },
    async ({ id, token }) => {
      assertToken(config, token);
      const { project, projectFile } = await requireActiveProject(session);

      const manifestByType = new Map<string, Awaited<ReturnType<typeof getManifestInfo>>>();
      for (const component of project.components) {
        if (!manifestByType.has(component.type)) {
          manifestByType.set(component.type, await getManifestInfo(component.type));
        }
      }

      const allSchemas = componentInputSchemaForProject(project, manifestByType);
      const componentId = String(id || '').trim();
      const filtered = componentId ? allSchemas.filter((entry) => entry.id === componentId) : allSchemas;

      return makeToolResult({
        ok: filtered.length > 0 || !componentId,
        action: 'component_input_schema',
        file: relToCwd(projectFile),
        count: filtered.length,
        components: filtered,
      });
    }
  );

  server.tool(
    'project_init',
    'Create a new OpenHW project JSON and set it as active session project.',
    {
      name: z.string().min(1),
      board: z.string().min(1),
      token: z.string().optional(),
    },
    async ({ name, board, token }) => {
      assertToken(config, token);

      const project = createProject(String(name), String(board));
      const fileName = `${toSafeSlug(name)}.json`;
      const projectFile = resolveWorkspacePath(path.join('temp', fileName));

      await saveProject(projectFile, project);
      session.projectFile = projectFile;

      return makeToolResult({
        ok: true,
        action: 'project_init',
        file: relToCwd(projectFile),
        summary: summarizeProject(project),
      });
    }
  );

  server.tool(
    'component_add',
    'Add a component to the active project.',
    {
      type: z.string().min(1),
      id: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      token: z.string().optional(),
    },
    async ({ type, id, x, y, token }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const component = await addComponent(project, {
        type,
        id,
        x,
        y,
      });
      await saveProject(projectFile, project);

      return makeToolResult({
        ok: true,
        action: 'component_add',
        file: relToCwd(projectFile),
        component,
      });
    }
  );

  server.tool(
    'wire_add',
    'Connect two endpoints in the active project.',
    {
      from: z.string().min(1),
      to: z.string().min(1),
      token: z.string().optional(),
    },
    async ({ from, to, token }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const wire = await addConnection(project, {
        from,
        to,
      });
      await saveProject(projectFile, project);

      return makeToolResult({
        ok: true,
        action: 'wire_add',
        file: relToCwd(projectFile),
        wire,
      });
    }
  );

  server.tool(
    'sim_execute',
    'Run simulation for the active project and return result with optional telemetry, trace, and console capture.',
    {
      ms: z.number().int().nonnegative().optional(),
      include_telemetry: z.boolean().optional(),
      include_trace: z.boolean().optional(),
      include_console: z.boolean().optional(),
      include_state: z.boolean().optional(),
      include_serial_text: z.boolean().optional(),
      trace_event_types: z.array(z.string()).optional(),
      component_id: z.string().optional(),
      max_events: z.number().int().positive().max(5000).optional(),
      max_console_chars: z.number().int().positive().max(250000).optional(),
      max_serial_chars: z.number().int().positive().max(10000).optional(),
      debug_mode: z.enum(['off', 'text', 'json']).optional(),
      board_id: z.string().optional(),
      all_boards: z.boolean().optional(),
      token: z.string().optional(),
    },
    async ({
      ms,
      include_telemetry,
      include_trace,
      include_console,
      include_state,
      include_serial_text,
      trace_event_types,
      component_id,
      max_events,
      max_console_chars,
      max_serial_chars,
      debug_mode,
      board_id,
      all_boards,
      token,
    }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const durationMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms))) : 1000;
      const includeTelemetry = !!include_telemetry;
      const includeTrace = !!include_trace;
      const includeConsole = !!include_console;

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        boardId: board_id,
        allBoards: !!all_boards,
        durationMs,
        debugMode: debug_mode || (includeTrace ? 'json' : 'off'),
        telemetryMode: 'off',
      };

      const { result, telemetry, trace, droppedTraceEvents, consoleText } = await runSimulationForDuration(
        project,
        runOptions,
        includeTelemetry,
        {
          includeTrace,
          includeConsole,
          maxEvents: clampPositiveInt(max_events, 300, 1, 5000),
          maxConsoleChars: clampPositiveInt(max_console_chars, 8000, 256, 250000),
          traceEventTypes: normalizeTraceEventTypes(trace_event_types),
          traceBuild: {
            includeState: !!include_state,
            includeSerialText: !!include_serial_text,
            maxSerialChars: clampPositiveInt(max_serial_chars, 120, 16, 10000),
            componentId: String(component_id || '').trim() || null,
          },
        }
      );

      const payload: Record<string, unknown> = {
        ok: true,
        action: 'sim_execute',
        file: relToCwd(projectFile),
        durationMs,
        runOptions: {
          boardId: runOptions.boardId || null,
          allBoards: !!runOptions.allBoards,
          debugMode: runOptions.debugMode,
        },
        result,
      };

      if (telemetry) {
        payload.telemetry = telemetry;
      }

      if (includeTrace) {
        payload.trace = trace;
        payload.traceSummary = {
          capturedEvents: trace.length,
          droppedEvents: droppedTraceEvents,
        };
      }

      if (includeConsole) {
        payload.console = {
          text: consoleText,
          length: consoleText.length,
        };
      }

      return makeToolResult(payload);
    }
  );

  server.tool(
    'sim_trace',
    'Capture a bounded simulation trace timeline (state, serial, fault, debug) for the active project.',
    {
      ms: z.number().int().positive().optional(),
      board_id: z.string().optional(),
      all_boards: z.boolean().optional(),
      include_state: z.boolean().optional(),
      include_serial_text: z.boolean().optional(),
      trace_event_types: z.array(z.string()).optional(),
      component_id: z.string().optional(),
      max_events: z.number().int().positive().max(5000).optional(),
      max_serial_chars: z.number().int().positive().max(10000).optional(),
      max_console_chars: z.number().int().positive().max(250000).optional(),
      include_telemetry: z.boolean().optional(),
      include_console: z.boolean().optional(),
      debug_mode: z.enum(['off', 'text', 'json']).optional(),
      token: z.string().optional(),
    },
    async ({
      ms,
      board_id,
      all_boards,
      include_state,
      include_serial_text,
      trace_event_types,
      component_id,
      max_events,
      max_serial_chars,
      max_console_chars,
      include_telemetry,
      include_console,
      debug_mode,
      token,
    }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const durationMs = clampPositiveInt(ms, 2000, 1, 1200000);
      const includeTelemetry = !!include_telemetry;
      const includeConsole = !!include_console;

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        boardId: board_id,
        allBoards: !!all_boards,
        durationMs,
        debugMode: debug_mode || 'json',
        telemetryMode: 'off',
      };

      const { result, telemetry, trace, droppedTraceEvents, consoleText } = await runSimulationForDuration(
        project,
        runOptions,
        includeTelemetry,
        {
          includeTrace: true,
          includeConsole,
          maxEvents: clampPositiveInt(max_events, 400, 1, 5000),
          maxConsoleChars: clampPositiveInt(max_console_chars, 12000, 256, 250000),
          traceEventTypes: normalizeTraceEventTypes(trace_event_types),
          traceBuild: {
            includeState: !!include_state,
            includeSerialText: !!include_serial_text,
            maxSerialChars: clampPositiveInt(max_serial_chars, 120, 16, 10000),
            componentId: String(component_id || '').trim() || null,
          },
        }
      );

      const eventTypeCounts: Record<string, number> = {};
      for (const event of trace) {
        eventTypeCounts[event.type] = Number(eventTypeCounts[event.type] || 0) + 1;
      }

      const payload: Record<string, unknown> = {
        ok: true,
        action: 'sim_trace',
        file: relToCwd(projectFile),
        durationMs,
        summary: {
          capturedEvents: trace.length,
          droppedEvents: droppedTraceEvents,
          eventTypeCounts,
        },
        result,
        trace,
      };

      if (telemetry) {
        payload.telemetry = telemetry;
      }

      if (includeConsole) {
        payload.console = {
          text: consoleText,
          length: consoleText.length,
        };
      }

      return makeToolResult(payload);
    }
  );

  server.tool(
    'simulation_step',
    'Run deterministic step-based simulation control with optional timed inputs and bounded trace capture.',
    {
      steps: z.number().int().positive().max(500).optional(),
      step_ms: z.number().int().positive().max(60000).optional(),
      board_id: z.string().optional(),
      all_boards: z.boolean().optional(),
      include_trace: z.boolean().optional(),
      include_console: z.boolean().optional(),
      include_state: z.boolean().optional(),
      include_serial_text: z.boolean().optional(),
      include_diff: z.boolean().optional(),
      include_display: z.boolean().optional(),
      include_pin_state: z.boolean().optional(),
      max_events: z.number().int().positive().max(5000).optional(),
      max_console_chars: z.number().int().positive().max(250000).optional(),
      max_serial_chars: z.number().int().positive().max(10000).optional(),
      inputs: z.array(z.object({
        id: z.string().optional(),
        event: z.any().optional(),
        value: z.any().optional(),
        at_ms: z.number().int().nonnegative().optional(),
        profile: z.string().optional(),
      })).optional(),
      token: z.string().optional(),
    },
    async ({
      steps,
      step_ms,
      board_id,
      all_boards,
      include_trace,
      include_console,
      include_state,
      include_serial_text,
      include_diff,
      include_display,
      include_pin_state,
      max_events,
      max_console_chars,
      max_serial_chars,
      inputs,
      token,
    }) => {
      assertToken(config, token);
      const { project, projectFile } = await requireActiveProject(session);
      const totalSteps = clampPositiveInt(steps, 8, 1, 500);
      const stepMs = clampPositiveInt(step_ms, 120, 1, 60000);
      const durationMs = totalSteps * stepMs;
      const includeTrace = !!include_trace;
      const includeConsole = !!include_console;

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        boardId: board_id,
        allBoards: !!all_boards,
        durationMs: 0,
        debugMode: includeTrace ? 'json' : 'off',
        telemetryMode: 'off',
      };

      const runtimeCapture = createRuntimeCapture({
        includeTrace,
        includeConsole,
        maxEvents: clampPositiveInt(max_events, 400, 1, 5000),
        maxConsoleChars: clampPositiveInt(max_console_chars, 10000, 256, 250000),
        traceEventTypes: [],
        traceBuild: {
          includeState: !!include_state,
          includeSerialText: !!include_serial_text,
          maxSerialChars: clampPositiveInt(max_serial_chars, 120, 16, 10000),
          componentId: null,
        },
      });

      const scheduledInputs = normalizeInputEventsForStep({
        project,
        durationMs,
        inputs: Array.isArray(inputs) ? inputs : [],
      });

      const controller = await startSimulation(project, runOptions, {
        suppressConsoleOutput: true,
        onEvent: runtimeCapture.onEvent,
      });

      const snapshots: Array<{ step: number; tMs: number; boards: number; components: number }> = [];
      let elapsedMs = 0;
      let inputCursor = 0;
      for (let step = 1; step <= totalSteps; step += 1) {
        const nextElapsed = step * stepMs;
        while (inputCursor < scheduledInputs.length && scheduledInputs[inputCursor].atMs <= nextElapsed) {
          const inputEvent = scheduledInputs[inputCursor];
          controller.sendComponentEvent(inputEvent.id, inputEvent.event);
          inputCursor += 1;
        }
        await sleep(stepMs);
        elapsedMs = nextElapsed;
        const snapshot = controller.getSnapshot();
        snapshots.push({
          step,
          tMs: elapsedMs,
          boards: snapshot.boards.length,
          components: snapshot.components.length,
        });
      }

      controller.stop();

      const result = controller.getResult();
      const telemetry = controller.getTelemetryReport();
      const snapshot = controller.getSnapshot();
      const captured = runtimeCapture.flush();
      const displays = extractDisplayStates(snapshot, telemetry);

      return makeToolResult({
        ok: true,
        action: 'simulation_step',
        file: relToCwd(projectFile),
        run: {
          steps: totalSteps,
          stepMs,
          elapsedMs,
          boardId: board_id || null,
          allBoards: !!all_boards,
        },
        inputs: scheduledInputs,
        snapshots,
        pinState: normalizeBoardPinStates(snapshot),
        displays,
        result,
        telemetry,
        trace: includeTrace ? captured.trace : undefined,
        traceSummary: includeTrace
          ? {
              capturedEvents: captured.trace.length,
              droppedEvents: captured.droppedTraceEvents,
            }
          : undefined,
        console: includeConsole
          ? {
              text: captured.consoleText,
              length: captured.consoleText.length,
            }
          : undefined,
      });
    }
  );

  server.tool(
    'simulation_assert',
    'Run a short simulation and evaluate assertion checks against telemetry, display state, and pin values.',
    {
      ms: z.number().int().positive().optional(),
      board_id: z.string().optional(),
      all_boards: z.boolean().optional(),
      assertions: z.array(z.object({
        type: z.string(),
        component_id: z.string().optional(),
        board_id: z.string().optional(),
        pin: z.string().optional(),
        text: z.string().optional(),
        status: z.enum(['ok', 'warn', 'error']).optional(),
        high: z.boolean().optional(),
      })),
      token: z.string().optional(),
    },
    async ({ ms, board_id, all_boards, assertions, token }) => {
      assertToken(config, token);
      const { project, projectFile } = await requireActiveProject(session);
      const durationMs = clampPositiveInt(ms, 1200, 1, 1200000);

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        boardId: board_id,
        allBoards: !!all_boards,
        durationMs,
        debugMode: 'off',
        telemetryMode: 'off',
      };

      const { result, telemetry } = await runSimulationForDuration(project, runOptions, true);
      const controller = await startSimulation(project, {
        ...runOptions,
        durationMs: 1,
      }, {
        suppressConsoleOutput: true,
      });
      await sleep(1);
      controller.stop();
      const snapshot = controller.getSnapshot();

      const displays = extractDisplayStates(snapshot, telemetry);
      const assertionResult = evaluateAssertions({
        checks: assertions as any,
        displays,
        telemetry,
        snapshot,
      });

      return makeToolResult({
        ok: assertionResult.ok,
        action: 'simulation_assert',
        file: relToCwd(projectFile),
        durationMs,
        result,
        assertions: assertionResult,
      });
    }
  );

  server.tool(
    'sim_inspect',
    'Inspect runtime board/component telemetry for the active project with optional event injection.',
    {
      id: z.string().optional(),
      ms: z.number().int().positive().optional(),
      board_id: z.string().optional(),
      all_boards: z.boolean().optional(),
      event: z.any().optional(),
      value: z.any().optional(),
      at_ms: z.number().int().nonnegative().optional(),
      include_trace: z.boolean().optional(),
      include_console: z.boolean().optional(),
      include_state: z.boolean().optional(),
      include_serial_text: z.boolean().optional(),
      include_diff: z.boolean().optional(),
      include_display: z.boolean().optional(),
      include_pin_state: z.boolean().optional(),
      max_events: z.number().int().positive().max(5000).optional(),
      max_console_chars: z.number().int().positive().max(250000).optional(),
      max_serial_chars: z.number().int().positive().max(10000).optional(),
      debug_mode: z.enum(['off', 'text', 'json']).optional(),
      token: z.string().optional(),
    },
    async ({
      id,
      ms,
      board_id,
      all_boards,
      event,
      value,
      at_ms,
      include_trace,
      include_console,
      include_state,
      include_serial_text,
      include_diff,
      include_display,
      include_pin_state,
      max_events,
      max_console_chars,
      max_serial_chars,
      debug_mode,
      token,
    }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const durationMs = clampPositiveInt(ms, 1400, 1, 1200000);
      const componentId = String(id || '').trim();
      const injectEvent = event !== undefined;

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        boardId: board_id,
        allBoards: !!all_boards,
        durationMs,
        debugMode: debug_mode || (include_trace ? 'json' : 'off'),
        telemetryMode: 'off',
      };

      const runtimeCapture = createRuntimeCapture({
        includeTrace: !!include_trace,
        includeConsole: !!include_console,
        maxEvents: clampPositiveInt(max_events, 300, 1, 5000),
        maxConsoleChars: clampPositiveInt(max_console_chars, 10000, 256, 250000),
        traceEventTypes: [],
        traceBuild: {
          includeState: !!include_state,
          includeSerialText: !!include_serial_text,
          maxSerialChars: clampPositiveInt(max_serial_chars, 120, 16, 10000),
          componentId: componentId || null,
        },
      });

      const controller = await startSimulation(project, runOptions, {
        suppressConsoleOutput: true,
        onEvent: runtimeCapture.onEvent,
      });

      let delivered = false;
      let eventPayload: unknown = null;
      let eventAtMs = 0;
      let beforeSnapshot = controller.getSnapshot();
      let beforeTelemetry = controller.getTelemetryReport();
      let correlationId = '';

      if (injectEvent) {
        const targetComponentId = componentId;
        if (!targetComponentId) {
          controller.stop();
          throw new Error('sim_inspect event injection requires id (component id).');
        }

        eventPayload = buildInteractionEvent(event, value);
        eventAtMs = Math.min(durationMs, Math.max(0, Number(at_ms || 0)));
        if (eventAtMs > 0) {
          await sleep(eventAtMs);
        }

        beforeSnapshot = controller.getSnapshot();
        beforeTelemetry = controller.getTelemetryReport();
        correlationId = buildCorrelationId('inspect');
        delivered = controller.sendComponentEvent(targetComponentId, eventPayload);
      }

      const remainingMs = Math.max(0, durationMs - eventAtMs);
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }

      controller.stop();

      const result = controller.getResult();
      const telemetry = controller.getTelemetryReport();
      const snapshot = controller.getSnapshot();
      const captured = runtimeCapture.flush();
      const displays = include_display === false ? [] : extractDisplayStates(snapshot, telemetry);

      const componentTelemetry = componentId
        ? telemetry.components.find((component) => component.id === componentId) || null
        : null;
      const componentSnapshot = componentId
        ? snapshot.components.find((component) => component.id === componentId) || null
        : null;
      const componentDefinition = componentId
        ? project.components.find((component) => component.id === componentId) || null
        : null;

      const payload: Record<string, unknown> = {
        ok: !injectEvent || delivered,
        action: 'sim_inspect',
        file: relToCwd(projectFile),
        durationMs,
        result,
        boards: telemetry.boards,
      };

      if (componentId) {
        payload.component = {
          id: componentId,
          definition: componentDefinition,
          telemetry: componentTelemetry,
          snapshotState: componentSnapshot?.state || null,
        };
      } else {
        payload.components = telemetry.components;
      }

      if (injectEvent) {
        payload.eventProbe = {
          componentId,
          event: eventPayload,
          atMs: eventAtMs,
          delivered,
          correlationId: correlationId || null,
        };
      }

      if (include_pin_state !== false) {
        payload.pinState = normalizeBoardPinStates(snapshot);
      }

      if (include_display !== false) {
        payload.displays = displays;
      }

      if (injectEvent && include_diff !== false) {
        payload.diff = {
          boardPins: diffBoardPins(beforeSnapshot, snapshot),
          components: diffComponentStates(beforeSnapshot, snapshot, componentId || null),
          displays: {
            before: extractDisplayStates(beforeSnapshot, beforeTelemetry),
            after: displays,
          },
        };
      }

      if (include_trace) {
        payload.trace = captured.trace;
        if (correlationId) {
          payload.correlatedTrace = captured.trace
            .filter((entry) => entry.tMs >= eventAtMs)
            .map((entry) => ({ ...entry, correlationId }));
        }
        payload.traceSummary = {
          capturedEvents: captured.trace.length,
          droppedEvents: captured.droppedTraceEvents,
        };
      }

      if (include_console) {
        payload.console = {
          text: captured.consoleText,
          length: captured.consoleText.length,
        };
      }

      return makeToolResult(payload);
    }
  );

  server.tool(
    'component_interact',
    'Inject a component event in the active project and return telemetry for the target.',
    {
      id: z.string().min(1),
      event: z.any(),
      value: z.any().optional(),
      token: z.string().optional(),
    },
    async ({ id, event, value, token }) => {
      assertToken(config, token);

      const { project, projectFile } = await requireActiveProject(session);
      const eventPayload = buildInteractionEvent(event, value);

      const runOptions: SimulationRunOptions = {
        backendUrl: config.backendUrl,
        durationMs: 1200,
        debugMode: 'off',
        telemetryMode: 'off',
      };

      const controller = await startSimulation(project, runOptions, { suppressConsoleOutput: true });
      await sleep(150);
      const delivered = controller.sendComponentEvent(id, eventPayload);
      await sleep(1050);
      controller.stop();

      const result = controller.getResult();
      const telemetry = controller.getTelemetryReport();
      const targetTelemetry = telemetry.components.find((c) => c.id === id) || null;

      return makeToolResult({
        ok: delivered,
        action: 'component_interact',
        file: relToCwd(projectFile),
        componentId: id,
        delivered,
        event: eventPayload,
        targetTelemetry,
        result,
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
