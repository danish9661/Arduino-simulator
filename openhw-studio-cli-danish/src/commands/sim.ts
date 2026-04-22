import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import YAML from 'yaml';
import type {
  OpenHwProject,
  SimulationRunOptions,
  SimulationSnapshot,
  SimulationTelemetryReport,
} from '../types.js';
import {
  captureStaticSnapshot,
  getDefaultBoardForStdin,
  startSimulation,
} from '../sim/session.js';
import { renderSnapshotSvg } from '../sim/screenshot.js';
import { loadProject, summarizeProject, validateProject } from '../utils/project.js';
import { BOARD_DEFAULT_BAUD, normalizeBoardKind } from '../utils/boards.js';
import { getManifestInfo } from '../utils/manifests.js';
import { FRONTEND_ROOT, relToCwd, resolveWorkspacePath } from '../utils/paths.js';
import {
  buildProfileEvents,
  componentInputSchemaForProject,
  diffBoardPins,
  diffComponentStates,
  evaluateAssertions,
  extractDisplayStates,
  normalizeBoardPinStates,
} from '../sim/agent-observability.js';

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseNonNegative(input: string | undefined, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function healthIcon(status: 'ok' | 'warn' | 'error'): string {
  if (status === 'error') return '🔴';
  if (status === 'warn') return '🟡';
  return '🟢';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatTelemetryLeaf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',...' : ''}}`;
  }
  return String(value);
}

function formatCustomTelemetry(custom: Record<string, unknown> | null): string {
  if (!custom) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(custom)) {
    parts.push(`${key}=${formatTelemetryLeaf(value)}`);
    if (parts.length >= 6) break;
  }
  return parts.join(', ');
}

function formatTiming(universalMetrics?: Record<string, unknown>): string {
  const timing = asRecord(universalMetrics?.timing);
  if (!timing) return '';
  const avgMs = Number(timing.avgMs);
  const maxMs = Number(timing.maxMs);
  if (!Number.isFinite(avgMs) && !Number.isFinite(maxMs)) return '';
  const avgText = Number.isFinite(avgMs) ? avgMs.toFixed(3) : 'n/a';
  const maxText = Number.isFinite(maxMs) ? maxMs.toFixed(3) : 'n/a';
  return `avg=${avgText}ms max=${maxText}ms`;
}

function printTelemetryTextReport(
  telemetry: SimulationTelemetryReport,
  projectFile: string,
  outputFile?: string
): void {
  const problematic = telemetry.components.filter((c) => c.status !== 'ok');
  process.stdout.write(`Telemetry report for ${relToCwd(resolveWorkspacePath(projectFile))}\n`);
  process.stdout.write(
    `Components=${telemetry.components.length} Boards=${telemetry.boards.length} Faults=${telemetry.faults} SerialChars=${telemetry.serialChars} Problematic=${problematic.length}\n`
  );
  if (outputFile) {
    process.stdout.write(`Output=${relToCwd(resolveWorkspacePath(outputFile))}\n`);
  }

  for (const component of telemetry.components) {
    const icon = healthIcon(component.status);
    const timing = formatTiming(component.universalMetrics);

    const telemetryData = asRecord(component.telemetryData);
    const custom = asRecord(
      telemetryData?.customTelemetry
      ?? telemetryData?.custom
      ?? asRecord(component.universalMetrics)?.custom
    );
    const customText = formatCustomTelemetry(custom);
    const summary = String(component.outputSummary || component.telemetrySummary || '').trim();

    process.stdout.write(`${icon} ${component.id} (${component.type})${timing ? ` [${timing}]` : ''}\n`);
    if (summary) {
      process.stdout.write(`  summary: ${summary}\n`);
    }
    if (customText) {
      process.stdout.write(`  custom: ${customText}\n`);
    }
    if (component.notes.length > 0) {
      process.stdout.write(`  notes: ${component.notes.join(' | ')}\n`);
    }
  }
}

function parseCsvList(input: string | undefined): string[] {
  return String(input || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hasInspectEventInput(options: {
  eventJson?: string;
  eventFile?: string;
  event?: string;
  value?: string;
}): boolean {
  return Boolean(options.eventJson || options.eventFile || options.event || options.value !== undefined);
}

type TraceRecord = {
  tMs: number;
  boardId: string;
  type: string;
  detail: Record<string, unknown>;
};

type TraceCaptureOptions = {
  includeState: boolean;
  includeSerialText: boolean;
  maxSerialChars: number;
  componentFilter: string | null;
};

function compactTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (ArrayBuffer.isView(value)) {
    const typed = value as unknown as { length?: number; [k: number]: number };
    const len = Number(typed.length || 0);
    const preview: number[] = [];
    for (let i = 0; i < Math.min(len, 16); i += 1) {
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
        preview: value.slice(0, 8).map((item) => compactTraceValue(item, depth + 1)),
      };
    }
    return value.map((item) => compactTraceValue(item, depth + 1));
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

function buildTraceRecord(message: any, startedAtMs: number, options: TraceCaptureOptions): TraceRecord | null {
  const type = String(message?.type || '').trim() || 'unknown';
  const boardId = String(message?.boardId || 'default').trim() || 'default';
  const tMs = Math.max(0, Date.now() - startedAtMs);

  if (type === 'serial') {
    const chunk = String(message?.data || '');
    const source = String(message?.source || 'uart0');
    const detail: Record<string, unknown> = {
      source,
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
    const components = Array.isArray(message?.components)
      ? (message.components as Array<Record<string, unknown>>)
          .map((component) => {
            const id = String(component?.id || '').trim();
            if (!id) return null;
            if (options.componentFilter && id !== options.componentFilter) return null;

            const state =
              component?.state && typeof component.state === 'object' && !Array.isArray(component.state)
                ? (component.state as Record<string, unknown>)
                : {};

            const entry: Record<string, unknown> = {
              id,
              stateKeys: Object.keys(state).sort((a, b) => a.localeCompare(b)),
            };

            const telemetrySummary = String(component?.telemetrySummary || '').trim();
            if (telemetrySummary) {
              entry.telemetrySummary = telemetrySummary;
            }

            if (options.includeState) {
              entry.state = compactTraceValue(state);
              if (component?.telemetryData && typeof component.telemetryData === 'object') {
                entry.telemetryData = compactTraceValue(component.telemetryData);
              }
            }

            return entry;
          })
          .filter((entry): entry is Record<string, unknown> => !!entry)
      : [];

    const detail: Record<string, unknown> = {};

    if (message?.pins && typeof message.pins === 'object') {
      const pinKeys = Object.keys(message.pins as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
      if (pinKeys.length > 0) {
        detail.pinKeys = pinKeys;
      }
    }

    if (Object.prototype.hasOwnProperty.call(message || {}, 'analog')) {
      const analog = (message as Record<string, unknown>).analog;
      detail.analog = options.includeState
        ? compactTraceValue(analog)
        : Array.isArray(analog)
          ? { kind: 'array', length: analog.length }
          : typeof analog;
    }

    if (components.length > 0) {
      detail.components = components;
    }

    if (Object.keys(detail).length === 0) {
      return null;
    }

    return {
      tMs,
      boardId,
      type,
      detail,
    };
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

function pickDebugMode(input: string | undefined): SimulationRunOptions['debugMode'] {
  const mode = String(input || 'off').toLowerCase();
  if (mode === 'off' || mode === 'text' || mode === 'json') {
    return mode;
  }
  throw new Error('Invalid --debug mode. Expected one of: off, text, json');
}

function pickTelemetryMode(input: string | undefined): SimulationRunOptions['telemetryMode'] {
  const mode = String(input || 'off').toLowerCase();
  if (mode === 'off' || mode === 'text' || mode === 'json') {
    return mode;
  }
  throw new Error('Invalid --telemetry mode. Expected one of: off, text, json');
}

function resolveDefaultBaud(projectBoardType: string, provided: string | undefined): number {
  const parsed = Number(provided);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  const kind = normalizeBoardKind(projectBoardType);
  return BOARD_DEFAULT_BAUD[kind] || 9600;
}

function parseLooseValue(input: string): unknown {
  const trimmed = String(input || '').trim();
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

function classifyRole(type: string, group: string): 'board' | 'input' | 'output' | 'other' {
  if (/(arduino|esp32|stm32|rp2040|pico)/i.test(type)) return 'board';
  const g = String(group || '').toLowerCase();
  if (/(output|display|actuator|memory)/.test(g)) return 'output';
  if (/(sensor|input|basic|communication|logic)/.test(g)) return 'input';
  return 'other';
}

function interactionTemplatesForType(type: string): any[] {
  const t = String(type || '').toLowerCase();

  if (t.includes('pushbutton')) {
    return ['press', 'release'];
  }

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

  if (t.includes('sd-card')) {
    return [
      { type: 'mount' },
      { type: 'unmount' },
      { type: 'write-file', path: '/log.txt', data: 'hello from cli' },
    ];
  }

  return [{ type: 'input', value: 50 }, { type: 'SET_ATTR', key: 'value', value: 50 }];
}

async function resolveEventInput(options: {
  eventJson?: string;
  eventFile?: string;
  event?: string;
  value?: string;
  key?: string;
}): Promise<any> {
  if (options.eventJson && options.eventFile) {
    throw new Error('Use only one event source: --event-json or --event-file.');
  }

  if (options.eventJson) {
    return JSON.parse(options.eventJson);
  }

  if (options.eventFile) {
    const raw = await fs.readFile(resolveWorkspacePath(options.eventFile), 'utf8');
    return JSON.parse(raw);
  }

  if (options.event) {
    if (options.key) {
      return {
        type: options.event,
        key: options.key,
        value: options.value !== undefined ? parseLooseValue(options.value) : null,
      };
    }

    if (options.value !== undefined) {
      return {
        type: options.event,
        value: parseLooseValue(options.value),
      };
    }

    if (options.event === 'press' || options.event === 'release') {
      return options.event;
    }

    return { type: options.event };
  }

  if (options.value !== undefined) {
    return { type: 'input', value: parseLooseValue(options.value) };
  }

  throw new Error('Provide interaction payload via --event-json, --event-file, --event, or --value.');
}

async function writeOutputFile(targetPath: string, content: string): Promise<void> {
  const absolute = resolveWorkspacePath(targetPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

async function parseScenarioFile(inputPath: string): Promise<unknown> {
  const absolute = resolveWorkspacePath(inputPath);
  const raw = await fs.readFile(absolute, 'utf8');
  const ext = path.extname(absolute).toLowerCase();
  return ext === '.yaml' || ext === '.yml' ? YAML.parse(raw) : JSON.parse(raw);
}

async function runForDuration(
  project: Awaited<ReturnType<typeof loadProject>>,
  runOptions: SimulationRunOptions
): Promise<{ result: any; telemetry: SimulationTelemetryReport; snapshot: SimulationSnapshot }> {
  const controller = await startSimulation(project, runOptions);

  const waitMs = parsePositiveInt(String(runOptions.durationMs), 0);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } else {
    await new Promise<void>((resolve) => {
      const onSigint = () => {
        process.off('SIGINT', onSigint);
        resolve();
      };
      process.on('SIGINT', onSigint);
    });
  }

  controller.stop();
  return {
    result: controller.getResult(),
    telemetry: controller.getTelemetryReport(),
    snapshot: controller.getSnapshot(),
  };
}

async function loadRoutingModule(): Promise<any> {
  const routingPath = path.join(FRONTEND_ROOT, 'src', 'worker', 'protocol-routing.js');
  const moduleUrl = pathToFileURL(routingPath).href;
  return import(moduleUrl);
}

function buildConnectionChecker(project: Awaited<ReturnType<typeof loadProject>>): (a: string, b: string) => boolean {
  const adjacency = new Map<string, Set<string>>();

  const connect = (a: string, b: string) => {
    if (!a || !b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set<string>());
    if (!adjacency.has(b)) adjacency.set(b, new Set<string>());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };

  for (const wire of project.connections || []) {
    connect(String(wire.from || ''), String(wire.to || ''));
  }

  for (const c of project.components || []) {
    if (/resistor/i.test(String(c.type || ''))) {
      connect(`${c.id}:p1`, `${c.id}:p2`);
    }
  }

  const netMap = new Map<string, number>();
  let net = 1;

  for (const start of adjacency.keys()) {
    if (netMap.has(start)) continue;
    const queue = [start];
    netMap.set(start, net);

    while (queue.length) {
      const node = queue.shift()!;
      const neighbors = adjacency.get(node);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (netMap.has(next)) continue;
        netMap.set(next, net);
        queue.push(next);
      }
    }

    net += 1;
  }

  return (a: string, b: string) => {
    const na = netMap.get(a);
    const nb = netMap.get(b);
    return na !== undefined && na === nb;
  };
}

export function registerSimCommands(program: Command, getBackendUrl: () => string): void {
  const sim = program.command('sim').description('Simulation run, telemetry, input, and screenshot commands');

  sim
    .command('run <projectFile>')
    .description('Compile and run simulation from project JSON')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project and route UART/soft-serial between them')
    .option('--duration-ms <ms>', 'Auto-stop after duration (0 = run until Ctrl+C)', '0')
    .option('--debug <mode>', 'Debug output mode: off|text|json', 'off')
    .option('--telemetry <mode>', 'Telemetry stream mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--serial-input <text>', 'Send one serial payload at startup')
    .option('--stdin-serial', 'Forward stdin chunks into simulation serial RX')
    .option('--stdin-board-id <id>', 'Board id target for stdin serial when multiple boards run')
    .option('--snapshot-json <file>', 'Write runtime snapshot JSON to file')
    .option('--screenshot-out <file>', 'Write SVG screenshot of final simulation state')
    .option('--telemetry-out <file>', 'Write telemetry JSON report to file')
    .option('--fail-on-fault', 'Exit with non-zero code when faults are reported')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const validation = await validateProject(project);
      if (!validation.valid) {
        process.stderr.write('[sim] project validation has errors, run may fail.\n');
      }

      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs: parsePositiveInt(options.durationMs, 0),
        debugMode: pickDebugMode(options.debug),
        telemetryMode: pickTelemetryMode(options.telemetry),
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
        serialInput: options.serialInput,
        stdinSerial: !!options.stdinSerial,
        stdinBoardId: options.stdinBoardId || getDefaultBoardForStdin(project),
      };

      const startedAt = new Date().toISOString();
      const { result, telemetry, snapshot } = await runForDuration(project, runOptions);

      if (options.snapshotJson) {
        await writeOutputFile(options.snapshotJson, `${JSON.stringify(snapshot, null, 2)}\n`);
      }

      if (options.telemetryOut) {
        await writeOutputFile(options.telemetryOut, `${JSON.stringify(telemetry, null, 2)}\n`);
      }

      if (options.screenshotOut) {
        const svg = await renderSnapshotSvg(project, snapshot, telemetry);
        await writeOutputFile(options.screenshotOut, svg);
      }

      const payload: Record<string, unknown> = {
        ok: true,
        action: 'sim.run',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        startedAt,
        backendUrl: runOptions.backendUrl,
        options: {
          boardId: runOptions.boardId || null,
          allBoards: !!runOptions.allBoards,
          durationMs: runOptions.durationMs,
          debugMode: runOptions.debugMode,
          telemetryMode: runOptions.telemetryMode,
          baudRate: runOptions.baudRate,
          stdinSerial: !!runOptions.stdinSerial,
          stdinBoardId: runOptions.stdinBoardId || null,
        },
        result,
      };

      if (runOptions.telemetryMode !== 'off') {
        payload.telemetry = telemetry;
      }

      if (options.snapshotJson) {
        payload.snapshotJson = relToCwd(resolveWorkspacePath(options.snapshotJson));
      }
      if (options.telemetryOut) {
        payload.telemetryOut = relToCwd(resolveWorkspacePath(options.telemetryOut));
      }
      if (options.screenshotOut) {
        payload.screenshotOut = relToCwd(resolveWorkspacePath(options.screenshotOut));
      }

      printJson(payload);

      if (options.failOnFault && Number(result?.faultCount || 0) > 0) {
        process.exitCode = 1;
      }
    });

  sim
    .command('telemetry <projectFile>')
    .description('Run simulation and emit per-component telemetry/health report')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Run duration before telemetry report', '2500')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--watch', 'Stream one-line component telemetry updates until Ctrl+C')
    .option('--interval-ms <ms>', 'Refresh interval for --watch mode', '1000')
    .option('--json', 'Print telemetry only as JSON')
    .option('--output <file>', 'Write telemetry report to JSON file')
    .option('--fail-on-warn', 'Exit non-zero when any component status is warn/error')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs: parsePositiveInt(options.durationMs, 2500),
        debugMode: pickDebugMode(options.debug),
        telemetryMode: 'off',
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
      };

      if (!options.watch) {
        const { telemetry } = await runForDuration(project, runOptions);

        if (options.output) {
          await writeOutputFile(options.output, `${JSON.stringify(telemetry, null, 2)}\n`);
        }

        if (options.json) {
          printJson(telemetry);
        } else {
          printTelemetryTextReport(telemetry, projectFile, options.output);
        }

        if (options.failOnWarn && telemetry.components.some((c) => c.status !== 'ok')) {
          process.exitCode = 1;
        }
        return;
      }

      const intervalMs = Math.max(250, parsePositiveInt(options.intervalMs, 1000));
      const controller = await startSimulation(
        project,
        {
          ...runOptions,
          durationMs: 0,
        },
        {
          suppressConsoleOutput: true,
        }
      );

      let latestTelemetry = controller.getTelemetryReport();
      const render = () => {
        latestTelemetry = controller.getTelemetryReport();
        if (options.json) {
          printJson(latestTelemetry);
          return;
        }
        console.clear();
        printTelemetryTextReport(latestTelemetry, projectFile, options.output);
      };

      if (!options.json) {
        process.stdout.write('Telemetry watch mode active. Press Ctrl+C to stop.\n');
      }
      render();
      const timer = setInterval(render, intervalMs);

      await new Promise<void>((resolve) => {
        const onSigint = () => {
          process.off('SIGINT', onSigint);
          resolve();
        };
        process.on('SIGINT', onSigint);
      });

      clearInterval(timer);
      controller.stop();
      latestTelemetry = controller.getTelemetryReport();

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(latestTelemetry, null, 2)}\n`);
      }

      if (!options.json) {
        process.stdout.write('\nTelemetry watch stopped. Final snapshot:\n');
        printTelemetryTextReport(latestTelemetry, projectFile, options.output);
      }

      if (options.failOnWarn && latestTelemetry.components.some((c) => c.status !== 'ok')) {
        process.exitCode = 1;
      }
    });

  sim
    .command('trace <projectFile>')
    .description('Capture a bounded runtime trace timeline (serial/state/fault/debug events)')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Trace capture duration in milliseconds', '2000')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--component-id <id>', 'Filter state events to one component id')
    .option('--event-types <csv>', 'Comma-separated event types filter (e.g. state,serial,fault,debug)')
    .option('--max-events <n>', 'Maximum trace events to keep in memory', '300')
    .option('--include-state', 'Include compact component state payloads for state events')
    .option('--include-serial-text', 'Include serial chunk text in serial events')
    .option('--max-serial-chars <n>', 'Max serial chars kept per serial event when --include-serial-text', '120')
    .option('--output <file>', 'Write trace payload JSON to file')
    .option('--fail-on-fault', 'Exit non-zero when runtime faults are observed')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const durationMs = Math.max(1, parsePositiveInt(options.durationMs, 2000));
      const maxEvents = Math.max(1, parsePositiveInt(options.maxEvents, 300));
      const maxSerialChars = Math.max(16, parsePositiveInt(options.maxSerialChars, 120));
      const componentFilter = String(options.componentId || '').trim() || null;
      const typeFilterList = parseCsvList(options.eventTypes);
      const typeFilter = typeFilterList.length > 0 ? new Set(typeFilterList) : null;

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs,
        debugMode: pickDebugMode(options.debug),
        telemetryMode: 'off',
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
      };

      const traceOptions: TraceCaptureOptions = {
        includeState: !!options.includeState,
        includeSerialText: !!options.includeSerialText,
        maxSerialChars,
        componentFilter,
      };

      const startedAtMs = Date.now();
      const trace: TraceRecord[] = [];
      let droppedEvents = 0;

      const controller = await startSimulation(project, runOptions, {
        suppressConsoleOutput: true,
        onEvent: (event) => {
          const record = buildTraceRecord(event, startedAtMs, traceOptions);
          if (!record) return;

          if (typeFilter && !typeFilter.has(record.type.toLowerCase())) {
            return;
          }

          if (trace.length >= maxEvents) {
            droppedEvents += 1;
            return;
          }

          trace.push(record);
        },
      });

      await sleep(durationMs);
      controller.stop();

      const result = controller.getResult();
      const telemetry = controller.getTelemetryReport();
      const eventTypeCounts: Record<string, number> = {};
      for (const record of trace) {
        eventTypeCounts[record.type] = Number(eventTypeCounts[record.type] || 0) + 1;
      }

      const payload = {
        ok: true,
        action: 'sim.trace',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        options: {
          boardId: runOptions.boardId || null,
          allBoards: !!runOptions.allBoards,
          durationMs,
          debugMode: runOptions.debugMode,
          baudRate: runOptions.baudRate,
          componentFilter,
          eventTypes: typeFilterList,
          includeState: traceOptions.includeState,
          includeSerialText: traceOptions.includeSerialText,
          maxEvents,
        },
        summary: {
          capturedEvents: trace.length,
          droppedEvents,
          eventTypeCounts,
          faults: telemetry.faults,
          serialChars: telemetry.serialChars,
        },
        result,
        trace,
      };

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
      }

      printJson({
        ...payload,
        output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
      });

      if (options.failOnFault && Number(telemetry.faults || 0) > 0) {
        process.exitCode = 1;
      }
    });

  sim
    .command('interact <projectFile>')
    .description('Send component input event during simulation (e.g. sliders, button press/release, attrs)')
    .requiredOption('--component-id <id>', 'Target component id')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Total run duration', '2200')
    .option('--at-ms <ms>', 'When to inject event after simulation starts', '200')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--event <name>', 'Event name (e.g. input, SET_ATTR, press, release)')
    .option('--value <value>', 'Event value (number/string/json)')
    .option('--key <key>', 'Event key for SET_ATTR-style payloads')
    .option('--event-json <json>', 'Full event JSON payload')
    .option('--event-file <file>', 'Path to JSON event payload file')
    .option('--telemetry-out <file>', 'Write telemetry report to JSON file')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const eventPayload = await resolveEventInput({
        eventJson: options.eventJson,
        eventFile: options.eventFile,
        event: options.event,
        value: options.value,
        key: options.key,
      });

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs: parsePositiveInt(options.durationMs, 2200),
        debugMode: pickDebugMode(options.debug),
        telemetryMode: 'off',
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
      };

      const controller = await startSimulation(project, runOptions);
      const injectDelayMs = parseNonNegative(options.atMs, 200);
      if (injectDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, injectDelayMs));
      }

      const delivered = controller.sendComponentEvent(String(options.componentId), eventPayload);

      const remainingMs = Math.max(0, Number(runOptions.durationMs || 0) - injectDelayMs);
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      controller.stop();
      const telemetry = controller.getTelemetryReport();
      const target = telemetry.components.find((c) => c.id === options.componentId) || null;

      if (options.telemetryOut) {
        await writeOutputFile(options.telemetryOut, `${JSON.stringify(telemetry, null, 2)}\n`);
      }

      printJson({
        ok: delivered,
        action: 'sim.interact',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        componentId: options.componentId,
        delivered,
        event: eventPayload,
        targetTelemetry: target,
        telemetryOut: options.telemetryOut ? relToCwd(resolveWorkspacePath(options.telemetryOut)) : null,
      });

      if (!delivered) {
        process.exitCode = 1;
      }
    });

  sim
    .command('inspect <projectFile>')
    .description('Inspect runtime board/component state and telemetry with optional event probing')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Run duration before collecting inspection snapshot', '1800')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--component-id <id>', 'Inspect one component id in detail')
    .option('--verbose', 'Include full component telemetry list when inspecting whole project')
    .option('--event-component-id <id>', 'Target component id for injected event (defaults to --component-id)')
    .option('--at-ms <ms>', 'When to inject event after simulation starts', '200')
    .option('--event <name>', 'Event name (e.g. input, SET_ATTR, press, release)')
    .option('--value <value>', 'Event value (number/string/json)')
    .option('--key <key>', 'Event key for SET_ATTR-style payloads')
    .option('--event-json <json>', 'Full event JSON payload')
    .option('--event-file <file>', 'Path to JSON event payload file')
    .option('--output <file>', 'Write inspection report JSON to file')
    .option('--fail-on-warn', 'Exit non-zero when inspected status is warn/error')
    .option('--fail-on-fault', 'Exit non-zero when runtime faults are observed')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const componentId = String(options.componentId || '').trim();
      const durationMs = Math.max(1, parsePositiveInt(options.durationMs, 1800));

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs,
        debugMode: pickDebugMode(options.debug),
        telemetryMode: 'off',
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
      };

      const shouldInjectEvent = hasInspectEventInput({
        eventJson: options.eventJson,
        eventFile: options.eventFile,
        event: options.event,
        value: options.value,
      });

      let eventPayload: any = null;
      let eventTargetComponentId = '';
      let delivered = false;
      let eventDelayMs = 0;

      if (shouldInjectEvent) {
        eventPayload = await resolveEventInput({
          eventJson: options.eventJson,
          eventFile: options.eventFile,
          event: options.event,
          value: options.value,
          key: options.key,
        });

        eventTargetComponentId = String(options.eventComponentId || componentId || '').trim();
        if (!eventTargetComponentId) {
          throw new Error('When providing inspect event payload, set --event-component-id or --component-id.');
        }
      }

      const controller = await startSimulation(project, runOptions, {
        suppressConsoleOutput: true,
      });

      if (eventPayload !== null) {
        eventDelayMs = Math.min(durationMs, parseNonNegative(options.atMs, 200));
        if (eventDelayMs > 0) {
          await sleep(eventDelayMs);
        }
        delivered = controller.sendComponentEvent(eventTargetComponentId, eventPayload);
      }

      const remainingMs = Math.max(0, durationMs - eventDelayMs);
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }

      controller.stop();

      const result = controller.getResult();
      const telemetry = controller.getTelemetryReport();
      const snapshot = controller.getSnapshot();

      const boardInspection = telemetry.boards.map((board) => ({
        ...board,
        pinKeys: Object.keys(snapshot.pinsByBoard[board.id] || {}).sort((a, b) => a.localeCompare(b)),
      }));

      const componentDefinition = componentId
        ? project.components.find((component) => component.id === componentId) || null
        : null;
      const componentTelemetry = componentId
        ? telemetry.components.find((component) => component.id === componentId) || null
        : null;
      const componentSnapshot = componentId
        ? snapshot.components.find((component) => component.id === componentId) || null
        : null;

      const componentFound = !componentId
        || !!componentDefinition
        || !!componentTelemetry
        || !!componentSnapshot;

      const componentOverview = componentId
        ? {
            id: componentId,
            existsInProject: !!componentDefinition,
            definition: componentDefinition,
            telemetry: componentTelemetry,
            snapshotState: componentSnapshot?.state || null,
            snapshotBounds: componentSnapshot
              ? {
                  x: componentSnapshot.x,
                  y: componentSnapshot.y,
                  w: componentSnapshot.w,
                  h: componentSnapshot.h,
                }
              : null,
          }
        : null;

      const projectComponentView = componentId
        ? null
        : options.verbose
          ? telemetry.components
          : telemetry.components.map((component) => ({
              id: component.id,
              type: component.type,
              role: component.role,
              status: component.status,
              updates: component.updates,
              changedKeys: component.changedKeys,
              outputSummary: component.outputSummary,
              notes: component.notes,
            }));

      const payload = {
        ok: componentFound && (eventPayload === null || delivered),
        action: 'sim.inspect',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        options: {
          boardId: runOptions.boardId || null,
          allBoards: !!runOptions.allBoards,
          durationMs,
          debugMode: runOptions.debugMode,
          baudRate: runOptions.baudRate,
          componentId: componentId || null,
          verbose: !!options.verbose,
        },
        result,
        boards: boardInspection,
        component: componentOverview,
        components: projectComponentView,
        eventProbe:
          eventPayload !== null
            ? {
                targetComponentId: eventTargetComponentId,
                event: eventPayload,
                atMs: eventDelayMs,
                delivered,
              }
            : null,
      };

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
      }

      printJson({
        ...payload,
        output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
      });

      if (options.failOnFault && Number(telemetry.faults || 0) > 0) {
        process.exitCode = 1;
      }

      if (options.failOnWarn) {
        if (componentTelemetry) {
          if (componentTelemetry.status !== 'ok') {
            process.exitCode = 1;
          }
        } else if (telemetry.components.some((component) => component.status !== 'ok')) {
          process.exitCode = 1;
        }
      }

      if (!componentFound || (eventPayload !== null && !delivered)) {
        process.exitCode = 1;
      }
    });

  sim
    .command('probe <projectFile>')
    .description('Inject one input/profile and return before/after component+pin+display behavior diff')
    .requiredOption('--component-id <id>', 'Target component id')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Total probe runtime', '1800')
    .option('--at-ms <ms>', 'When to inject event', '250')
    .option('--event <name>', 'Event name (e.g. input, SET_ATTR, press)')
    .option('--value <value>', 'Event value (number/string/json)')
    .option('--key <key>', 'Event key for SET_ATTR payloads')
    .option('--event-json <json>', 'Full event JSON payload')
    .option('--event-file <file>', 'Path to JSON event payload file')
    .option('--profile <name>', 'Sensor profile name from sim capabilities')
    .option('--assertions-file <file>', 'JSON/YAML assertions file')
    .option('--output <file>', 'Write full probe payload JSON')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      const selectedBoard = options.boardId
        ? boardSummary.find((b) => b.id === options.boardId)
        : boardSummary.length === 1
          ? boardSummary[0]
          : undefined;

      const componentId = String(options.componentId || '').trim();
      const targetComponent = project.components.find((entry) => entry.id === componentId);
      if (!targetComponent) {
        throw new Error(`Component not found: ${componentId}`);
      }

      const durationMs = Math.max(1, parsePositiveInt(options.durationMs, 1800));
      const eventAtMs = Math.min(durationMs, parseNonNegative(options.atMs, 250));

      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs,
        debugMode: 'off',
        telemetryMode: 'off',
        baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
      };

      const controller = await startSimulation(project, runOptions, { suppressConsoleOutput: true });
      if (eventAtMs > 0) {
        await sleep(eventAtMs);
      }

      const beforeSnapshot = controller.getSnapshot();
      const beforeTelemetry = controller.getTelemetryReport();

      const eventsToInject: Array<{ atMs: number; event: unknown }> = [];
      if (options.profile) {
        eventsToInject.push(...buildProfileEvents(String(options.profile), targetComponent.type, durationMs));
      } else {
        eventsToInject.push({
          atMs: eventAtMs,
          event: await resolveEventInput({
            eventJson: options.eventJson,
            eventFile: options.eventFile,
            event: options.event,
            value: options.value,
            key: options.key,
          }),
        });
      }

      let delivered = true;
      let cursorMs = eventAtMs;
      for (const entry of eventsToInject.sort((a, b) => a.atMs - b.atMs)) {
        const waitMs = Math.max(0, entry.atMs - cursorMs);
        if (waitMs > 0) await sleep(waitMs);
        delivered = controller.sendComponentEvent(componentId, entry.event) && delivered;
        cursorMs = entry.atMs;
      }

      const remainingMs = Math.max(0, durationMs - cursorMs);
      if (remainingMs > 0) await sleep(remainingMs);
      controller.stop();

      const afterSnapshot = controller.getSnapshot();
      const telemetry = controller.getTelemetryReport();
      const displays = extractDisplayStates(afterSnapshot, telemetry);
      const payload: Record<string, unknown> = {
        ok: delivered,
        action: 'sim.probe',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        componentId,
        delivered,
        injected: eventsToInject,
        pinState: normalizeBoardPinStates(afterSnapshot),
        displays,
        diff: {
          boardPins: diffBoardPins(beforeSnapshot, afterSnapshot),
          components: diffComponentStates(beforeSnapshot, afterSnapshot, componentId),
          displays: {
            before: extractDisplayStates(beforeSnapshot, beforeTelemetry),
            after: displays,
          },
        },
        targetTelemetry: telemetry.components.find((entry) => entry.id === componentId) || null,
      };

      if (options.assertionsFile) {
        const checksRaw = await parseScenarioFile(String(options.assertionsFile));
        const checksRoot = (checksRaw && typeof checksRaw === 'object') ? (checksRaw as Record<string, unknown>) : {};
        const checks = Array.isArray(checksRoot.assertions) ? checksRoot.assertions : checksRaw;
        payload.assertions = evaluateAssertions({
          checks: Array.isArray(checks) ? checks : [],
          displays,
          telemetry,
          snapshot: afterSnapshot,
        });
        if ((payload.assertions as { ok?: boolean }).ok === false) {
          process.exitCode = 1;
        }
      }

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
      }

      printJson({
        ...payload,
        output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
      });

      if (!delivered) {
        process.exitCode = 1;
      }
    });

  sim
    .command('display <projectFile>')
    .description('Run simulation and return normalized display-focused state snapshots')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Run duration before capture', '1400')
    .option('--output <file>', 'Write display payload JSON')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: options.boardId,
        allBoards: !!options.allBoards,
        durationMs: Math.max(1, parsePositiveInt(options.durationMs, 1400)),
        debugMode: 'off',
        telemetryMode: 'off',
      };

      const { telemetry, snapshot } = await runForDuration(project, runOptions);
      const displays = extractDisplayStates(snapshot, telemetry);
      const payload = {
        ok: true,
        action: 'sim.display',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        count: displays.length,
        displays,
      };

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
      }

      printJson({
        ...payload,
        output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
      });
    });

  sim
    .command('scenario <projectFile>')
    .description('Run repeatable simulation scenario with timed inputs and assertions from JSON/YAML')
    .requiredOption('--scenario <file>', 'Scenario JSON/YAML file path')
    .option('--output <file>', 'Write scenario report JSON')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const scenario = (await parseScenarioFile(String(options.scenario))) as Record<string, unknown>;
      const durationMs = Math.max(1, parsePositiveInt(String(scenario?.durationMs || '1800'), 1800));
      const runOptions: SimulationRunOptions = {
        backendUrl: getBackendUrl(),
        boardId: typeof scenario?.boardId === 'string' ? scenario.boardId : undefined,
        allBoards: !!scenario?.allBoards,
        durationMs,
        debugMode: 'off',
        telemetryMode: 'off',
      };

      const controller = await startSimulation(project, runOptions, { suppressConsoleOutput: true });
      const inputs = Array.isArray(scenario?.inputs) ? (scenario.inputs as Array<Record<string, unknown>>) : [];
      let cursorMs = 0;
      let deliveredAll = true;

      for (const input of inputs.sort((a, b) => Number(a?.atMs || 0) - Number(b?.atMs || 0))) {
        const atMs = Math.max(0, Math.min(durationMs, Number(input?.atMs || 0)));
        const waitMs = Math.max(0, atMs - cursorMs);
        if (waitMs > 0) await sleep(waitMs);
        cursorMs = atMs;

        const targetId = String(input?.componentId || '').trim();
        if (!targetId) continue;
        let eventPayload: unknown = input?.event;

        if (String(input?.profile || '').trim()) {
          const component = project.components.find((entry) => entry.id === targetId);
          if (component) {
            const profileEvents = buildProfileEvents(String(input.profile), component.type, durationMs);
            for (const profileEvent of profileEvents) {
              const profileWaitMs = Math.max(0, profileEvent.atMs - cursorMs);
              if (profileWaitMs > 0) await sleep(profileWaitMs);
              cursorMs = profileEvent.atMs;
              deliveredAll = controller.sendComponentEvent(targetId, profileEvent.event) && deliveredAll;
            }
            continue;
          }
        }

        if (input && typeof input === 'object' && !eventPayload) {
          eventPayload = {
            type: input.eventName || 'input',
            value: input.value,
            ...(input.key ? { key: input.key } : {}),
          };
        }

        deliveredAll = controller.sendComponentEvent(targetId, eventPayload) && deliveredAll;
      }

      const remainingMs = Math.max(0, durationMs - cursorMs);
      if (remainingMs > 0) await sleep(remainingMs);
      controller.stop();

      const snapshot = controller.getSnapshot();
      const telemetry = controller.getTelemetryReport();
      const displays = extractDisplayStates(snapshot, telemetry);
      const checks = Array.isArray(scenario?.assertions) ? scenario.assertions : [];
      const assertions = evaluateAssertions({
        checks,
        displays,
        telemetry,
        snapshot,
      });

      const payload = {
        ok: deliveredAll && assertions.ok,
        action: 'sim.scenario',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        scenario: relToCwd(resolveWorkspacePath(options.scenario)),
        durationMs,
        deliveredAll,
        assertions,
        pinState: normalizeBoardPinStates(snapshot),
        displays,
        telemetrySummary: {
          faults: telemetry.faults,
          serialChars: telemetry.serialChars,
          nonOk: telemetry.components.filter((entry) => entry.status !== 'ok').map((entry) => entry.id),
        },
      };

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
      }

      printJson({
        ...payload,
        output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
      });

      if (!payload.ok) {
        process.exitCode = 1;
      }
    });

  sim
    .command('screenshot <projectFile>')
    .description('Export simulation screenshot SVG for running or non-running project state')
    .requiredOption('--output <file>', 'SVG output file path')
    .option('--board-id <id>', 'Board component id to run')
    .option('--all-boards', 'Run all boards in project')
    .option('--duration-ms <ms>', 'Run before capture; 0 captures static snapshot', '0')
    .option('--debug <mode>', 'Debug mode: off|text|json', 'off')
    .option('--baud <baud>', 'Serial baud override')
    .option('--snapshot-json <file>', 'Write snapshot JSON file')
    .option('--telemetry-json <file>', 'Write telemetry JSON file (runtime capture only)')
    .action(async (projectFile: string, options: any) => {
      const project = await loadProject(projectFile);
      const durationMs = parsePositiveInt(options.durationMs, 0);

      let snapshot: SimulationSnapshot;
      let telemetry: SimulationTelemetryReport | undefined;

      if (durationMs > 0) {
        const boardSummary = summarizeProject(project).boards as Array<{ id: string; type: string }>;
        const selectedBoard = options.boardId
          ? boardSummary.find((b) => b.id === options.boardId)
          : boardSummary.length === 1
            ? boardSummary[0]
            : undefined;

        const runOptions: SimulationRunOptions = {
          backendUrl: getBackendUrl(),
          boardId: options.boardId,
          allBoards: !!options.allBoards,
          durationMs,
          debugMode: pickDebugMode(options.debug),
          telemetryMode: 'off',
          baudRate: resolveDefaultBaud(selectedBoard?.type || project.board, options.baud),
        };

        const runtime = await runForDuration(project, runOptions);
        snapshot = runtime.snapshot;
        telemetry = runtime.telemetry;
      } else {
        snapshot = await captureStaticSnapshot(project);
        telemetry = undefined;
      }

      const svg = await renderSnapshotSvg(project, snapshot, telemetry);
      await writeOutputFile(options.output, svg);

      if (options.snapshotJson) {
        await writeOutputFile(options.snapshotJson, `${JSON.stringify(snapshot, null, 2)}\n`);
      }

      if (options.telemetryJson && telemetry) {
        await writeOutputFile(options.telemetryJson, `${JSON.stringify(telemetry, null, 2)}\n`);
      }

      printJson({
        ok: true,
        action: 'sim.screenshot',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        runtimeCaptured: durationMs > 0,
        durationMs,
        output: relToCwd(resolveWorkspacePath(options.output)),
        snapshotJson: options.snapshotJson ? relToCwd(resolveWorkspacePath(options.snapshotJson)) : null,
        telemetryJson:
          options.telemetryJson && telemetry
            ? relToCwd(resolveWorkspacePath(options.telemetryJson))
            : null,
      });
    });

  sim
    .command('capabilities <projectFile>')
    .description('List component interaction templates + output/input roles for CLI automation')
    .option('--json', 'Print JSON output')
    .action(async (projectFile: string, options: { json?: boolean }) => {
      const project = await loadProject(projectFile);
      const manifestByType = new Map<string, Awaited<ReturnType<typeof getManifestInfo>>>();
      for (const component of project.components) {
        if (!manifestByType.has(component.type)) {
          manifestByType.set(component.type, await getManifestInfo(component.type));
        }
      }
      const components = componentInputSchemaForProject(project, manifestByType);

      if (options.json) {
        printJson({
          ok: true,
          action: 'sim.capabilities',
          file: relToCwd(resolveWorkspacePath(projectFile)),
          components,
        });
        return;
      }

      for (const c of components) {
        process.stdout.write(
          `${c.id} (${c.type}) role=${c.role} interactive=${c.interactive ? 'yes' : 'no'} templates=${JSON.stringify(
            c.templates
          )}\n`
        );
      }
    });

  sim
    .command('check-routes <projectFile>')
    .description('Analyze UART and software-serial connectivity between boards')
    .option('--json', 'Print JSON output')
    .action(async (projectFile: string, options: { json?: boolean }) => {
      const project = await loadProject(projectFile);
      const boards = summarizeProject(project).boards as Array<{ id: string; type: string }>;
      if (boards.length < 2) {
        throw new Error('Route check requires at least two board components.');
      }

      const routing = await loadRoutingModule();
      const areConnected = buildConnectionChecker(project);

      const rows: Array<Record<string, unknown>> = [];
      for (const source of boards) {
        for (const target of boards) {
          if (source.id === target.id) continue;

          const uart0 = routing.resolveUartRoute
            ? routing.resolveUartRoute(source.id, source.type, target.id, target.type, areConnected, 'uart0')
            : { connected: false, targetSource: null };

          const uart1 = routing.resolveUartRoute
            ? routing.resolveUartRoute(source.id, source.type, target.id, target.type, areConnected, 'uart1')
            : { connected: false, targetSource: null };

          const soft = routing.areBoardsSoftSerialConnected
            ? routing.areBoardsSoftSerialConnected(source.id, source.type, target.id, target.type, areConnected)
            : false;

          rows.push({
            from: source.id,
            to: target.id,
            uart0,
            uart1,
            softSerial: soft,
          });
        }
      }

      if (options.json) {
        printJson({
          ok: true,
          action: 'sim.check-routes',
          file: relToCwd(resolveWorkspacePath(projectFile)),
          routes: rows,
        });
        return;
      }

      for (const row of rows) {
        process.stdout.write(
          `${row.from} -> ${row.to} | uart0=${(row.uart0 as any).connected ? 'yes' : 'no'} (${(row.uart0 as any).targetSource || '-'}) | uart1=${(row.uart1 as any).connected ? 'yes' : 'no'} (${(row.uart1 as any).targetSource || '-'}) | soft=${row.softSerial ? 'yes' : 'no'}\n`
        );
      }
    });

  sim
    .command('summary <projectFile>')
    .description('Print simulation-related project summary')
    .action(async (projectFile: string) => {
      const project = await loadProject(projectFile);
      const validation = await validateProject(project);
      printJson({
        ok: validation.valid,
        action: 'sim.summary',
        file: relToCwd(resolveWorkspacePath(projectFile)),
        summary: summarizeProject(project),
        validation,
      });
      if (!validation.valid) {
        process.exitCode = 1;
      }
    });
}
