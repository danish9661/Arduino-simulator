import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  OpenHwProject,
  SimulationRunOptions,
  SimulationRunResult,
  SimulationSnapshot,
  SimulationTelemetryReport,
} from '../types.js';
import { compileCode, fetchDefaultPicoMicroPythonUf2 } from '../utils/backend.js';
import {
  BOARD_DEFAULT_BAUD,
  getBoardComponents,
  isProgrammableBoardType,
  normalizeBoardKind,
  resolveBoardFqbn,
} from '../utils/boards.js';
import { FRONTEND_ROOT } from '../utils/paths.js';
import { getCodeForBoard, getCompileFilesForBoard } from '../utils/project.js';
import { SimulationTelemetryCollector } from './telemetry.js';

type RunnerLike = {
  boardId?: string;
  stop: () => void;
  reset?: () => void;
  serialRx: (payload: string) => void;
  serialRxByte?: (value: number) => void;
  serialRxByteFromSource?: (value: number, source?: string) => void;
  softSerialRxByte?: (value: number) => void;
  setSerialBaudRate?: (baud: number) => void;
  getSerialBaudRate?: () => number;
  instances?: Map<string, { onEvent?: (event: any) => void }>;
};

type RunnerFactory = (
  boardType: string,
  hexData: string,
  components: any[],
  wires: any[],
  onStateUpdate: (message: any) => void,
  options: Record<string, any>
) => RunnerLike;

type ProtocolRoutingModule = {
  resolveUartRoute?: (
    sourceBoardId: string,
    sourceType: string,
    targetBoardId: string,
    targetType: string,
    areConnected: (a: string, b: string) => boolean,
    source?: string
  ) => { connected: boolean; targetSource: string | null };
  areBoardsSoftSerialConnected?: (
    sourceBoardId: string,
    sourceType: string,
    targetBoardId: string,
    targetType: string,
    areConnected: (a: string, b: string) => boolean
  ) => boolean;
};

interface StartSimulationHooks {
  onEvent?: (event: any) => void;
  suppressConsoleOutput?: boolean;
}

interface NetIndex {
  areConnected: (pinA: string, pinB: string) => boolean;
}

interface CompiledBoardFirmware {
  boardId: string;
  boardType: string;
  firmware: string;
  pyScript: string;
}

interface BoardRuntime {
  boardId: string;
  boardType: string;
  runner: RunnerLike;
}

export interface SimulationController {
  boardId: string;
  boardType: string;
  boardIds: string[];
  boardTypes: Record<string, string>;
  stop: () => void;
  sendSerial: (payload: string, targetBoardId?: string) => void;
  sendComponentEvent: (componentId: string, event: any) => boolean;
  getSnapshot: () => SimulationSnapshot;
  getTelemetryReport: () => SimulationTelemetryReport;
  getResult: () => SimulationRunResult;
}

let cachedRunnerFactory: RunnerFactory | null = null;
let cachedProtocolRouting: ProtocolRoutingModule | null = null;

function sanitizeSketchName(input: string): string {
  return String(input || 'sketch').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function formatDebugLine(message: any): string {
  if (message?.category === 'rp2040-runtime') {
    const m = message.metrics || {};
    const pc = Number(m.pc);
    const pcHex = Number.isFinite(pc) ? `0x${(pc >>> 0).toString(16)}` : 'n/a';
    return [
      `reason=${message.reason || 'tick'}`,
      `pc=${pcHex}`,
      `cycles=${Number(m.cycles || 0)}`,
      `tx=${Number(m.serialTxBytes || 0)}`,
      `rx=${Number(m.serialRxBytes || 0)}`,
      `stall=${Number(m.pcStallTicks || 0)}`,
    ].join(' | ');
  }

  if (message?.category === 'rp2040-gdb') {
    return `gdb status=${message?.gdb?.status || 'unknown'} detail=${message?.gdb?.detail || ''}`;
  }

  if (message?.category === 'rp2040-wireless-stub') {
    return `wireless status=${message?.wireless?.status || 'unknown'} mode=${message?.wireless?.mode || 'n/a'}`;
  }

  return JSON.stringify(message);
}

function compactStateKeys(state: any): string {
  if (!state || typeof state !== 'object') return 'none';
  const keys = Object.keys(state);
  if (keys.length === 0) return 'none';
  return keys.slice(0, 8).join(', ');
}

function isSoftSerialLabel(label: string): boolean {
  const key = String(label || '').trim().toLowerCase();
  return (
    key === 'softserial' ||
    key === 'soft-serial' ||
    key === 'soft_uart' ||
    key === 'soft-uart' ||
    key === 'softuart'
  );
}

function buildNetIndex(project: OpenHwProject): NetIndex {
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

  for (const component of project.components || []) {
    if (/resistor/i.test(String(component.type || ''))) {
      connect(`${component.id}:p1`, `${component.id}:p2`);
    }
  }

  const pinToNet = new Map<string, number>();
  let net = 1;

  for (const start of adjacency.keys()) {
    if (pinToNet.has(start)) continue;

    const queue: string[] = [start];
    pinToNet.set(start, net);

    while (queue.length > 0) {
      const node = queue.shift()!;
      const neighbors = adjacency.get(node);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (pinToNet.has(next)) continue;
        pinToNet.set(next, net);
        queue.push(next);
      }
    }

    net += 1;
  }

  return {
    areConnected: (pinA: string, pinB: string) => {
      const netA = pinToNet.get(pinA);
      const netB = pinToNet.get(pinB);
      return netA !== undefined && netA === netB;
    },
  };
}

async function loadRunnerFactory(): Promise<RunnerFactory> {
  if (cachedRunnerFactory) {
    return cachedRunnerFactory;
  }

  const executePath = path.join(FRONTEND_ROOT, 'src', 'worker', 'execute.ts');
  const moduleUrl = pathToFileURL(executePath).href;
  const mod = await import(moduleUrl);

  if (typeof mod.createRunnerForBoard !== 'function') {
    throw new Error('Failed to load createRunnerForBoard from frontend worker execute.ts');
  }

  cachedRunnerFactory = mod.createRunnerForBoard as RunnerFactory;
  return cachedRunnerFactory;
}

async function loadProtocolRoutingModule(): Promise<ProtocolRoutingModule> {
  if (cachedProtocolRouting) {
    return cachedProtocolRouting;
  }

  const routingPath = path.join(FRONTEND_ROOT, 'src', 'worker', 'protocol-routing.js');
  const moduleUrl = pathToFileURL(routingPath).href;

  try {
    const mod = await import(moduleUrl);
    cachedProtocolRouting = {
      resolveUartRoute: typeof mod.resolveUartRoute === 'function' ? mod.resolveUartRoute : undefined,
      areBoardsSoftSerialConnected:
        typeof mod.areBoardsSoftSerialConnected === 'function' ? mod.areBoardsSoftSerialConnected : undefined,
    };
  } catch {
    cachedProtocolRouting = {};
  }

  return cachedProtocolRouting;
}

function selectBoards(project: OpenHwProject, options: SimulationRunOptions): Array<{ id: string; type: string }> {
  const boards = getBoardComponents(project).map((b) => ({ id: b.id, type: b.type }));

  if (boards.length === 0) {
    throw new Error('Project has no programmable board component to run.');
  }

  if (options.boardId) {
    const match = boards.find((b) => b.id === options.boardId);
    if (!match) {
      throw new Error(`Requested board id not found: ${options.boardId}`);
    }
    return [match];
  }

  if (options.allBoards) {
    return boards;
  }

  if (boards.length > 1) {
    throw new Error(
      `Project has multiple boards (${boards.map((b) => b.id).join(', ')}). Use --board-id or --all-boards.`
    );
  }

  return boards;
}

async function compileFirmwareForBoard(
  project: OpenHwProject,
  boardComp: { id: string; type: string },
  options: SimulationRunOptions
): Promise<CompiledBoardFirmware> {
  const boardKind = normalizeBoardKind(boardComp.type);
  const codeInfo = getCodeForBoard(project, boardComp.id);

  if (boardKind === 'rp2040' && codeInfo.isPython) {
    const uf2 = await fetchDefaultPicoMicroPythonUf2(options.backendUrl);
    return {
      boardId: boardComp.id,
      boardType: boardComp.type,
      firmware: `UF2BASE64:${uf2.toString('base64')}`,
      pyScript: codeInfo.source,
    };
  }

  const files = getCompileFilesForBoard(project, boardComp.id);
  const payload: Record<string, any> = {
    code: codeInfo.source || project.code || '',
    files,
    sketchName: sanitizeSketchName(boardComp.id),
    fqbn: resolveBoardFqbn(boardComp.type),
  };

  if (boardKind === 'rp2040') {
    payload.builder = 'arduino-pico';
  }

  const compiled = await compileCode(options.backendUrl, payload);
  if (!compiled?.hex || typeof compiled.hex !== 'string') {
    throw new Error(`Compile succeeded but did not return firmware hex payload for ${boardComp.id}.`);
  }

  return {
    boardId: boardComp.id,
    boardType: boardComp.type,
    firmware: compiled.hex,
    pyScript: '',
  };
}

function sendByteToRunner(runtime: BoardRuntime, value: number, source: string): void {
  if (runtime.runner.serialRxByteFromSource) {
    runtime.runner.serialRxByteFromSource(value, source);
    return;
  }

  if (isSoftSerialLabel(source) && runtime.runner.softSerialRxByte) {
    runtime.runner.softSerialRxByte(value);
    return;
  }

  if (runtime.runner.serialRxByte) {
    runtime.runner.serialRxByte(value);
    return;
  }

  runtime.runner.serialRx(String.fromCharCode(value & 0xff));
}

export async function startSimulation(
  project: OpenHwProject,
  options: SimulationRunOptions,
  hooks: StartSimulationHooks = {}
): Promise<SimulationController> {
  const selectedBoards = selectBoards(project, options);
  const runnerFactory = await loadRunnerFactory();

  const boardTypes: Record<string, string> = Object.fromEntries(
    selectedBoards.map((b) => [b.id, b.type])
  );

  const firmwareByBoard = new Map<string, CompiledBoardFirmware>();
  for (const board of selectedBoards) {
    const firmware = await compileFirmwareForBoard(project, board, options);
    firmwareByBoard.set(board.id, firmware);
  }

  const telemetryCollector = await SimulationTelemetryCollector.create(
    project,
    selectedBoards.map((b) => b.id)
  );

  const boardSerialChars = new Map<string, number>();
  const boardFaultCounts = new Map<string, number>();
  for (const board of selectedBoards) {
    boardSerialChars.set(board.id, 0);
    boardFaultCounts.set(board.id, 0);
  }

  const boardRuntimes = new Map<string, BoardRuntime>();
  const startedAt = Date.now();

  const emitEvent = (message: any, fallbackBoardId?: string) => {
    const suppressConsoleOutput = !!hooks.suppressConsoleOutput;
    const normalized =
      message && typeof message === 'object'
        ? { ...message }
        : {
            type: 'log',
            data: String(message),
          };

    if (!normalized.boardId && fallbackBoardId) {
      normalized.boardId = fallbackBoardId;
    }

    const boardId = String(normalized.boardId || '');

    telemetryCollector.onEvent(normalized);
    hooks.onEvent?.(normalized);

    if (normalized.type === 'serial') {
      const chunk = String(normalized.data || '');
      if (!suppressConsoleOutput) {
        process.stdout.write(chunk);
      }
      if (boardId) {
        boardSerialChars.set(boardId, Number(boardSerialChars.get(boardId) || 0) + chunk.length);
      }
      return;
    }

    if (normalized.type === 'fault') {
      if (boardId) {
        boardFaultCounts.set(boardId, Number(boardFaultCounts.get(boardId) || 0) + 1);
      }
      if (!suppressConsoleOutput) {
        process.stderr.write(
          `\n[fault:${boardId || 'unknown'}] ${String(normalized.reason || 'runtime fault')} @ ${String(
            normalized.pc ?? 'n/a'
          )}\n`
        );
      }
      return;
    }

    if (suppressConsoleOutput) {
      return;
    }

    if (options.debugMode === 'json') {
      process.stdout.write(`${JSON.stringify(normalized)}\n`);
      return;
    }

    if (normalized.type === 'debug' && options.debugMode === 'text') {
      process.stderr.write(`[debug:${boardId || 'unknown'}] ${formatDebugLine(normalized)}\n`);
    }

    if (options.telemetryMode === 'text' && normalized.type === 'state' && Array.isArray(normalized.components)) {
      for (const comp of normalized.components) {
        const compId = String(comp?.id || '');
        const keys = compactStateKeys(comp?.state);
        process.stderr.write(`[telemetry:${boardId || 'unknown'}] component=${compId} keys=${keys}\n`);
      }
    }

    if (options.telemetryMode === 'json' && normalized.type === 'state' && Array.isArray(normalized.components)) {
      const compact = {
        type: 'component-state',
        boardId,
        components: normalized.components.map((c: any) => ({
          id: c?.id,
          stateKeys: Object.keys((c?.state && typeof c.state === 'object' ? c.state : {}) as Record<string, unknown>),
        })),
      };
      process.stdout.write(`${JSON.stringify(compact)}\n`);
    }
  };

  if (selectedBoards.length === 1) {
    const board = selectedBoards[0];
    const firmware = firmwareByBoard.get(board.id)!;
    const boardKind = normalizeBoardKind(board.type);
    const baudRate = Number.isFinite(Number(options.baudRate))
      ? Number(options.baudRate)
      : BOARD_DEFAULT_BAUD[boardKind] || 9600;

    const runner = runnerFactory(
      board.type,
      firmware.firmware,
      project.components,
      project.connections,
      (stateMessage) => emitEvent(stateMessage, board.id),
      {
        boardId: board.id,
        serialBaudRate: baudRate,
        debugEnabled: options.debugMode !== 'off' || options.telemetryMode !== 'off',
        debugIntervalMs: 1000,
        pyScript: firmware.pyScript || undefined,
      }
    );

    boardRuntimes.set(board.id, {
      boardId: board.id,
      boardType: board.type,
      runner,
    });
  } else {
    const net = buildNetIndex(project);
    const routing = await loadProtocolRoutingModule();

    const selectedBoardIds = new Set(selectedBoards.map((b) => b.id));
    const sharedPeripheralComponents = project.components.filter((c) => !selectedBoardIds.has(c.id));

    const routeSerialByte = (sourceBoardId: string, value: number, sourceLabel = 'uart0') => {
      const sourceRuntime = boardRuntimes.get(sourceBoardId);
      if (!sourceRuntime) return;

      const sourceType = boardTypes[sourceBoardId] || sourceRuntime.boardType;
      const sourceBaud = sourceRuntime.runner.getSerialBaudRate?.() || 9600;
      const fromSoftSerial = isSoftSerialLabel(sourceLabel);

      for (const [targetBoardId, targetRuntime] of boardRuntimes.entries()) {
        if (targetBoardId === sourceBoardId) continue;

        const targetType = boardTypes[targetBoardId] || targetRuntime.boardType;
        const uartRoute = fromSoftSerial
          ? { connected: false, targetSource: null as string | null }
          : routing.resolveUartRoute
            ? routing.resolveUartRoute(
                sourceBoardId,
                sourceType,
                targetBoardId,
                targetType,
                net.areConnected,
                sourceLabel
              )
            : { connected: false, targetSource: null as string | null };

        const softLinked = routing.areBoardsSoftSerialConnected
          ? routing.areBoardsSoftSerialConnected(
              sourceBoardId,
              sourceType,
              targetBoardId,
              targetType,
              net.areConnected
            )
          : false;

        if (uartRoute.connected || softLinked) {
          targetRuntime.runner.setSerialBaudRate?.(sourceBaud);
          if (uartRoute.connected) {
            sendByteToRunner(targetRuntime, value, uartRoute.targetSource || 'uart0');
          } else {
            sendByteToRunner(targetRuntime, value, 'softserial');
          }
        }
      }
    };

    for (const board of selectedBoards) {
      const firmware = firmwareByBoard.get(board.id)!;
      const boardKind = normalizeBoardKind(board.type);
      const baudRate = Number.isFinite(Number(options.baudRate))
        ? Number(options.baudRate)
        : BOARD_DEFAULT_BAUD[boardKind] || 9600;

      const boardOnly = project.components.find((c) => c.id === board.id);
      if (!boardOnly) {
        throw new Error(`Board component missing in project: ${board.id}`);
      }

      const runner = runnerFactory(
        board.type,
        firmware.firmware,
        [boardOnly, ...sharedPeripheralComponents],
        project.connections,
        (stateMessage) => emitEvent(stateMessage, board.id),
        {
          boardId: board.id,
          serialBaudRate: baudRate,
          debugEnabled: options.debugMode !== 'off' || options.telemetryMode !== 'off',
          debugIntervalMs: 1000,
          pyScript: firmware.pyScript || undefined,
          onByteTransmit: ({ boardId, value, char, source }: any) => {
            emitEvent({ type: 'serial', data: char, value, boardId, source }, board.id);
            routeSerialByte(String(boardId || board.id), Number(value || 0), String(source || 'uart0'));
          },
        }
      );

      boardRuntimes.set(board.id, {
        boardId: board.id,
        boardType: board.type,
        runner,
      });
    }
  }

  if (options.serialInput) {
    const targetBoardId = options.boardId || selectedBoards[0]?.id;
    if (targetBoardId) {
      const target = boardRuntimes.get(targetBoardId);
      target?.runner.serialRx(String(options.serialInput));
    }
  }

  let stopped = false;
  let stdinAttached = false;
  let stdinHandler: ((chunk: string) => void) | null = null;

  const sendSerial = (payload: string, targetBoardId?: string) => {
    if (targetBoardId) {
      const target = boardRuntimes.get(targetBoardId);
      if (!target) {
        throw new Error(`Target board not running: ${targetBoardId}`);
      }
      target.runner.serialRx(String(payload));
      return;
    }

    if (boardRuntimes.size === 1) {
      const first = [...boardRuntimes.values()][0];
      first.runner.serialRx(String(payload));
      return;
    }

    for (const runtime of boardRuntimes.values()) {
      runtime.runner.serialRx(String(payload));
    }
  };

  if (options.stdinSerial) {
    const stdinTarget = options.stdinBoardId || options.boardId || selectedBoards[0]?.id;

    stdinHandler = (chunk: string) => {
      try {
        sendSerial(String(chunk), stdinTarget);
      } catch {
        for (const runtime of boardRuntimes.values()) {
          runtime.runner.serialRx(String(chunk));
        }
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', stdinHandler);
    stdinAttached = true;
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;

    if (stdinAttached && stdinHandler) {
      process.stdin.off('data', stdinHandler);
      process.stdin.pause();
      stdinAttached = false;
    }

    for (const runtime of boardRuntimes.values()) {
      runtime.runner.stop();
    }
  };

  const sendComponentEvent = (componentId: string, event: any): boolean => {
    let delivered = false;
    for (const runtime of boardRuntimes.values()) {
      const inst = runtime.runner.instances?.get(componentId);
      if (inst && typeof inst.onEvent === 'function') {
        inst.onEvent(event);
        delivered = true;
      }
    }
    return delivered;
  };

  const getTelemetryReport = (): SimulationTelemetryReport => {
    return telemetryCollector.getReport(Date.now() - startedAt);
  };

  const getSnapshot = (): SimulationSnapshot => {
    return telemetryCollector.getSnapshot();
  };

  const getResult = (): SimulationRunResult => {
    const boardResults = selectedBoards.map((board) => ({
      boardId: board.id,
      boardType: board.type,
      serialChars: Number(boardSerialChars.get(board.id) || 0),
      faultCount: Number(boardFaultCounts.get(board.id) || 0),
    }));

    return {
      elapsedMs: Date.now() - startedAt,
      boardId: selectedBoards[0]?.id || '',
      boardType: selectedBoards[0]?.type || '',
      boardIds: selectedBoards.map((b) => b.id),
      serialChars: boardResults.reduce((acc, b) => acc + b.serialChars, 0),
      faultCount: boardResults.reduce((acc, b) => acc + b.faultCount, 0),
      boardResults,
    };
  };

  return {
    boardId: selectedBoards[0]?.id || '',
    boardType: selectedBoards[0]?.type || '',
    boardIds: selectedBoards.map((b) => b.id),
    boardTypes,
    stop,
    sendSerial,
    sendComponentEvent,
    getSnapshot,
    getTelemetryReport,
    getResult,
  };
}

export async function runSimulationOnce(
  project: OpenHwProject,
  options: SimulationRunOptions,
  hooks: StartSimulationHooks = {}
): Promise<SimulationRunResult> {
  const controller = await startSimulation(project, options, hooks);

  if (options.durationMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.durationMs));
    controller.stop();

    const result = controller.getResult();
    if (options.telemetryMode && options.telemetryMode !== 'off') {
      result.telemetry = controller.getTelemetryReport();
    }
    return result;
  }

  await new Promise<void>((resolve) => {
    const onSigint = () => {
      process.off('SIGINT', onSigint);
      controller.stop();
      resolve();
    };

    process.on('SIGINT', onSigint);
  });

  const result = controller.getResult();
  if (options.telemetryMode && options.telemetryMode !== 'off') {
    result.telemetry = controller.getTelemetryReport();
  }
  return result;
}

export async function captureStaticSnapshot(project: OpenHwProject): Promise<SimulationSnapshot> {
  const boardIds = getBoardComponents(project).map((b) => b.id);
  const collector = await SimulationTelemetryCollector.create(project, boardIds);
  return collector.getSnapshot();
}

export function getDefaultBoardForStdin(project: OpenHwProject): string | undefined {
  const boards = getBoardComponents(project);
  if (boards.length === 0) return undefined;
  if (boards.length === 1) return boards[0].id;
  return boards.find((b) => isProgrammableBoardType(b.type))?.id || boards[0].id;
}
