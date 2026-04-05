import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type {
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

      const { telemetry } = await runForDuration(project, runOptions);

      if (options.output) {
        await writeOutputFile(options.output, `${JSON.stringify(telemetry, null, 2)}\n`);
      }

      if (options.json) {
        printJson(telemetry);
      } else {
        const problematic = telemetry.components.filter((c) => c.status !== 'ok');
        printJson({
          ok: true,
          action: 'sim.telemetry',
          file: relToCwd(resolveWorkspacePath(projectFile)),
          summary: {
            components: telemetry.components.length,
            boards: telemetry.boards.length,
            faults: telemetry.faults,
            serialChars: telemetry.serialChars,
            problematic: problematic.map((c) => ({ id: c.id, status: c.status, notes: c.notes })),
          },
          telemetry,
          output: options.output ? relToCwd(resolveWorkspacePath(options.output)) : null,
        });
      }

      if (options.failOnWarn && telemetry.components.some((c) => c.status !== 'ok')) {
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
      const components = await Promise.all(
        project.components.map(async (c) => {
          const info = await getManifestInfo(c.type);
          const group = info?.group || 'Other';
          const role = classifyRole(c.type, group);
          const templates = interactionTemplatesForType(c.type);
          return {
            id: c.id,
            type: c.type,
            label: c.label || c.id,
            group,
            role,
            interactive: !!info?.hasOnEvent || templates.length > 0,
            templates,
          };
        })
      );

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
