import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  OpenHwProject,
  SimulationRunOptions,
  SimulationRunResult,
  SimulationSnapshot,
  SimulationTelemetryReport,
} from '../types.js';
import {
  compileCode,
  fetchDefaultPicoCircuitPythonUf2,
  fetchDefaultPicoMicroPythonUf2,
} from '../utils/backend.js';
import {
  BOARD_DEFAULT_BAUD,
  getBoardComponents,
  isFileDisabled,
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
  pythonRuntimeEnv?: Rp2040RuntimeEnv;
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
let cachedRuntimeFsBuilders: RuntimeFsBuilders | null = null;

type Rp2040RuntimeEnv = 'native' | 'micropython' | 'circuitpython';

type RuntimeFsBuilders = {
  buildLittleFsImage?: (
    files: Array<{ path: string; data: unknown }>,
    options?: { sizeBytes?: number; blockSize?: number }
  ) => Promise<Uint8Array | null>;
  buildFatFsImage?: (
    files: Array<{ path: string; data: unknown }>,
    options?: { sizeBytes?: number; volumeLabel?: string }
  ) => Uint8Array | null;
};

const RP2040_LOGICAL_FLASH_BYTES = 2 * 1024 * 1024;
const RP2040_MICROPYTHON_FS_OFFSET = 0xA0000;
const RP2040_CIRCUITPYTHON_FS_OFFSET = 0x100000;
const RP2040_LITTLEFS_BLOCK_SIZE = 4096;

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

async function loadRuntimeFsBuilders(): Promise<RuntimeFsBuilders> {
  if (cachedRuntimeFsBuilders) {
    return cachedRuntimeFsBuilders;
  }

  const executePath = path.join(FRONTEND_ROOT, 'src', 'worker', 'execute.ts');
  const moduleUrl = pathToFileURL(executePath).href;
  const mod = await import(moduleUrl);

  cachedRuntimeFsBuilders = {
    buildLittleFsImage: typeof mod.buildLittleFsImage === 'function' ? mod.buildLittleFsImage : undefined,
    buildFatFsImage: typeof mod.buildFatFsImage === 'function' ? mod.buildFatFsImage : undefined,
  };
  return cachedRuntimeFsBuilders;
}

function normalizeRp2040RuntimeEnv(source: unknown): Rp2040RuntimeEnv {
  const value = String(source || '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'native' || value === 'ino') return 'native';
  if (value === 'cp' || value === 'circuitpy' || value === 'circuitpython' || value.startsWith('circuitpython')) {
    return 'circuitpython';
  }
  if (value === 'py' || value === 'python' || value === 'micropython' || value.startsWith('micropython')) {
    return 'micropython';
  }
  return 'native';
}

function getRp2040PythonEntryFileName(env: Rp2040RuntimeEnv): string {
  return env === 'circuitpython' ? 'code.py' : 'main.py';
}

function getRp2040PythonFsOffset(env: Rp2040RuntimeEnv): number {
  return env === 'circuitpython' ? RP2040_CIRCUITPYTHON_FS_OFFSET : RP2040_MICROPYTHON_FS_OFFSET;
}

function getRp2040PythonFsBytes(env: Rp2040RuntimeEnv): number {
  const offset = getRp2040PythonFsOffset(env);
  return Math.max(0, RP2040_LOGICAL_FLASH_BYTES - offset);
}

function normalizeRuntimePath(rawPath: unknown): string {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized) return '';

  const parts = normalized
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..');

  return parts.join('/');
}

function escapeRegExp(value: string): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runtimePathToModuleName(runtimePath: string): string | null {
  const normalized = normalizeRuntimePath(runtimePath);
  if (!normalized || !normalized.toLowerCase().endsWith('.py')) return null;

  const stem = normalized.slice(0, -3);
  const parts = stem.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) return null;
  return parts.join('.');
}

function flattenRuntimeModulePath(runtimePath: string): string {
  const normalized = normalizeRuntimePath(runtimePath);
  if (!normalized || !normalized.toLowerCase().endsWith('.py')) return normalized;
  if (!normalized.includes('/')) return normalized;

  const stem = normalized.slice(0, -3);
  const parts = stem.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return normalized;

  const base = parts[parts.length - 1];
  if (!base) return normalized;
  return `${base}.py`;
}

function collectRp2040RuntimeFiles(
  project: OpenHwProject,
  boardId: string,
  env: Rp2040RuntimeEnv,
  fallbackScript: string
): Array<{ path: string; data: string }> {
  const filesByPath = new Map<string, string>();
  const boardPrefix = `project/${boardId}/`;

  for (const file of project.projectFiles || []) {
    const fullPath = String(file.path || '');
    if (!fullPath.startsWith(boardPrefix) || isFileDisabled(fullPath)) continue;
    if (!fullPath.toLowerCase().endsWith('.py')) continue;

    const relPath = normalizeRuntimePath(fullPath.slice(boardPrefix.length));
    if (!relPath) continue;
    filesByPath.set(relPath, String(file.content || ''));
  }

  const fallback = String(fallbackScript || '');
  if (fallback.trim()) {
    const entryFile = getRp2040PythonEntryFileName(env);
    const existing = String(filesByPath.get(entryFile) || '');
    if (!existing.trim()) {
      filesByPath.set(entryFile, fallback);
    }
  }

  const runtimeEntries = Array.from(filesByPath.entries()).map(([path, data]) => ({ path, data }));
  const nestedEntries = runtimeEntries.filter((entry) => entry.path.includes('/'));
  if (nestedEntries.length === 0) {
    return runtimeEntries;
  }

  const rewriteMap = new Map<string, string>();
  for (const entry of nestedEntries) {
    const fromModule = runtimePathToModuleName(entry.path);
    const flattenedPath = flattenRuntimeModulePath(entry.path);
    const toModule = runtimePathToModuleName(flattenedPath);
    if (!fromModule || !toModule) continue;
    if (fromModule === toModule) continue;
    rewriteMap.set(fromModule, toModule);
  }

  const rewriteImports = (source: string): string => {
    let out = String(source || '');
    for (const [fromModule, toModule] of rewriteMap.entries()) {
      const fromPattern = new RegExp(`(^\\s*from\\s+)${escapeRegExp(fromModule)}(\\s+import\\s+)`, 'gm');
      const importPattern = new RegExp(`(^\\s*import\\s+)${escapeRegExp(fromModule)}(\\b|\\s+as\\s+[A-Za-z_][A-Za-z0-9_]*\\s*$)`, 'gm');
      out = out.replace(fromPattern, `$1${toModule}$2`);
      out = out.replace(importPattern, `$1${toModule}$2`);
    }
    return out;
  };

  const flattened = new Map<string, string>();
  for (const entry of runtimeEntries) {
    const nextPath = entry.path.includes('/')
      ? flattenRuntimeModulePath(entry.path)
      : entry.path;
    if (!nextPath) continue;

    const nextData = rewriteImports(entry.data);
    const existing = String(flattened.get(nextPath) || '');
    if (!existing.trim()) {
      flattened.set(nextPath, nextData);
    }
  }

  return Array.from(flattened.entries()).map(([path, data]) => ({ path, data }));
}

function buildCircuitPythonInjectedScript(runtimeFiles: Array<{ path: string; data: string }>): string {
  const files = Array.isArray(runtimeFiles) ? runtimeFiles : [];
  if (files.length === 0) return '';

  const normalizeModuleName = (runtimePath: string): string | null => {
    const normalized = normalizeRuntimePath(runtimePath);
    if (!normalized || !normalized.toLowerCase().endsWith('.py')) return null;

    const stem = normalized.slice(0, -3);
    const pathParts = stem.split('/').map((part) => part.trim()).filter(Boolean);
    if (pathParts.length === 0) return null;

    const rootStem = pathParts[0]?.toLowerCase() || '';
    if ((pathParts.length === 1) && (rootStem === 'code' || rootStem === 'main')) return null;

    if (!pathParts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) return null;
    return pathParts.join('.');
  };

  const mainFile = files.find((file) => String(file.path || '').toLowerCase() === 'code.py')
    || files.find((file) => String(file.path || '').toLowerCase() === 'main.py')
    || files.find((file) => String(file.path || '').toLowerCase().endsWith('.py'))
    || null;
  if (!mainFile) return '';

  let mainSource = String(mainFile.data || '');
  const lines: string[] = [];

  for (const file of files) {
    const moduleName = normalizeModuleName(String(file.path || ''));
    if (!moduleName) continue;

    const importFromPattern = new RegExp(`^\\s*from\\s+${escapeRegExp(moduleName)}\\s+import\\s+.*$`, 'gm');
    const importModulePattern = new RegExp(`^\\s*import\\s+${escapeRegExp(moduleName)}(?:\\s+as\\s+[A-Za-z_][A-Za-z0-9_]*)?\\s*$`, 'gm');
    mainSource = mainSource.replace(importFromPattern, '');
    mainSource = mainSource.replace(importModulePattern, '');

    lines.push(String(file.data || ''));
    lines.push('');
  }

  lines.push(mainSource);
  lines.push('');
  return lines.join('\n');
}

function scheduleCircuitPythonInject(
  runner: RunnerLike,
  runtimeFiles: Array<{ path: string; data: string }>,
  getSerialOutput: () => string,
  registerTimer: (timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) => void,
  delayMs = 1800
): void {
  const script = buildCircuitPythonInjectedScript(runtimeFiles);
  if (!script.trim()) return;

  let transportSource: 'usb' | 'uart0' = 'usb';

  const sendByte = (byte: number) => {
    const value = byte & 0xff;
    if (typeof runner.serialRxByteFromSource === 'function') {
      runner.serialRxByteFromSource(value, transportSource);
      return;
    }
    if (typeof runner.serialRxByte === 'function') {
      runner.serialRxByte(value);
      return;
    }
    runner.serialRx(String.fromCharCode(value));
  };

  const streamText = (text: string, chunkSize = 24, everyMs = 4) => {
    const bytes = Array.from(String(text || ''), (ch) => ch.charCodeAt(0) & 0xff);
    if (bytes.length === 0) return;

    let index = 0;
    const streamId = setInterval(() => {
      const end = Math.min(index + chunkSize, bytes.length);
      for (let i = index; i < end; i += 1) {
        sendByte(bytes[i]);
      }
      index = end;
      if (index >= bytes.length) {
        clearInterval(streamId);
      }
    }, Math.max(1, Number(everyMs || 1)));
    registerTimer(streamId);
  };

  const startedAt = Date.now();
  let injected = false;
  const pollId = setInterval(() => {
    if (injected) return;

    const runnerAny = runner as any;
    const usbReady = !!runnerAny?.usbCdcReady;
    const waitedMs = Date.now() - startedAt;
    if (!usbReady && waitedMs < Math.max(2200, Number(delayMs || 0))) {
      return;
    }

    transportSource = usbReady ? 'usb' : 'uart0';
    injected = true;
    clearInterval(pollId);

    streamText('x\r\u0003\u0003', 1, 18);
    const modeId = setTimeout(() => {
      streamText('\u0001', 1, 18);
    }, 120);
    registerTimer(modeId);

    const rawPromptStartedAt = Date.now();
    let scriptDispatched = false;
    const dispatchScript = () => {
      if (scriptDispatched) return;
      scriptDispatched = true;
      streamText(`${script}\n\u0004`, 24, 4);
    };

    const rawPromptPollId = setInterval(() => {
      if (scriptDispatched) {
        clearInterval(rawPromptPollId);
        return;
      }

      const waitedRawMs = Date.now() - rawPromptStartedAt;
      const serialText = String(getSerialOutput() || '');
      if (/raw REPL; CTRL-B to exit/.test(serialText)) {
        dispatchScript();
        clearInterval(rawPromptPollId);
        return;
      }

      if (waitedRawMs >= 2200) {
        dispatchScript();
        clearInterval(rawPromptPollId);
      }
    }, 80);
    registerTimer(rawPromptPollId);
  }, 120);
  registerTimer(pollId);
}

async function buildRp2040FlashPartitions(
  project: OpenHwProject,
  boardComp: { id: string; type: string; attrs?: Record<string, unknown> },
  firmware: CompiledBoardFirmware,
  runtimeFilesOverride?: Array<{ path: string; data: string }>
): Promise<Array<{ offset: number; data: Uint8Array }> | undefined> {
  const env = firmware.pythonRuntimeEnv || normalizeRp2040RuntimeEnv(boardComp.attrs?.env);
  if (env === 'native') return undefined;

  const runtimeFiles = Array.isArray(runtimeFilesOverride)
    ? runtimeFilesOverride
    : collectRp2040RuntimeFiles(project, boardComp.id, env, firmware.pyScript || '');
  if (runtimeFiles.length === 0) return undefined;

  // Directory-heavy Python layouts (for example lib/helper.py) are safer via raw-REPL
  // injection for now because RP2040 filesystem image builders are currently flat/limited.
  const hasNestedRuntimePaths = runtimeFiles.some((file) => normalizeRuntimePath(file.path).includes('/'));
  if (hasNestedRuntimePaths) return undefined;

  const fsBytes = getRp2040PythonFsBytes(env);
  if (fsBytes <= 0) return undefined;

  const fsBuilders = await loadRuntimeFsBuilders();
  let image: Uint8Array | null = null;

  if (env === 'circuitpython') {
    if (typeof fsBuilders.buildFatFsImage !== 'function') return undefined;
    image = fsBuilders.buildFatFsImage(runtimeFiles, {
      sizeBytes: fsBytes,
      volumeLabel: 'CIRCUITPY',
    });
  } else {
    if (typeof fsBuilders.buildLittleFsImage !== 'function') return undefined;
    image = await fsBuilders.buildLittleFsImage(runtimeFiles, {
      sizeBytes: fsBytes,
      blockSize: RP2040_LITTLEFS_BLOCK_SIZE,
    });
  }

  if (!image || image.length === 0) return undefined;

  return [{
    offset: getRp2040PythonFsOffset(env),
    data: image,
  }];
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

function selectBoards(
  project: OpenHwProject,
  options: SimulationRunOptions
): Array<{ id: string; type: string; attrs?: Record<string, unknown> }> {
  const boards = getBoardComponents(project).map((b) => ({
    id: b.id,
    type: b.type,
    attrs: (b.attrs && typeof b.attrs === 'object') ? b.attrs : {},
  }));

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
  boardComp: { id: string; type: string; attrs?: Record<string, unknown> },
  options: SimulationRunOptions
): Promise<CompiledBoardFirmware> {
  const boardKind = normalizeBoardKind(boardComp.type);
  const codeInfo = getCodeForBoard(project, boardComp.id);

  if (boardKind === 'rp2040' && codeInfo.isPython) {
    const runtimeEnv = normalizeRp2040RuntimeEnv(boardComp.attrs?.env);
    const uf2 = runtimeEnv === 'circuitpython'
      ? await fetchDefaultPicoCircuitPythonUf2(options.backendUrl)
      : await fetchDefaultPicoMicroPythonUf2(options.backendUrl);

    return {
      boardId: boardComp.id,
      boardType: boardComp.type,
      firmware: `UF2BASE64:${uf2.toString('base64')}`,
      pyScript: codeInfo.source,
      pythonRuntimeEnv: runtimeEnv === 'native' ? 'micropython' : runtimeEnv,
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

  const runtimeFilesByBoard = new Map<string, Array<{ path: string; data: string }>>();
  const flashPartitionsByBoard = new Map<string, Array<{ offset: number; data: Uint8Array }>>();
  for (const board of selectedBoards) {
    const firmware = firmwareByBoard.get(board.id);
    if (!firmware) continue;
    if (normalizeBoardKind(board.type) !== 'rp2040') continue;

    const env = firmware.pythonRuntimeEnv || normalizeRp2040RuntimeEnv(board.attrs?.env);
    const runtimeFiles = collectRp2040RuntimeFiles(project, board.id, env, firmware.pyScript || '');
    if (runtimeFiles.length > 0) {
      runtimeFilesByBoard.set(board.id, runtimeFiles);
    }

    const partitions = await buildRp2040FlashPartitions(project, board, firmware, runtimeFiles);
    if (Array.isArray(partitions) && partitions.length > 0) {
      flashPartitionsByBoard.set(board.id, partitions);
    }
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
  const boardSerialOutput = new Map<string, string>();
  const injectionTimers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];

  const registerInjectionTimer = (timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) => {
    injectionTimers.push(timer);
  };

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
        const merged = `${String(boardSerialOutput.get(boardId) || '')}${chunk}`;
        boardSerialOutput.set(boardId, merged.length > 8192 ? merged.slice(-8192) : merged);
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
        rp2040LogicalFlashBytes: RP2040_LOGICAL_FLASH_BYTES,
        rp2040FlashPartitions: flashPartitionsByBoard.get(board.id),
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
          rp2040LogicalFlashBytes: RP2040_LOGICAL_FLASH_BYTES,
          rp2040FlashPartitions: flashPartitionsByBoard.get(board.id),
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

  for (const board of selectedBoards) {
    const firmware = firmwareByBoard.get(board.id);
    if (!firmware) continue;
    if (normalizeBoardKind(board.type) !== 'rp2040') continue;

    const env = firmware.pythonRuntimeEnv || normalizeRp2040RuntimeEnv(board.attrs?.env);
    if (env !== 'micropython' && env !== 'circuitpython') continue;

    const partitions = flashPartitionsByBoard.get(board.id);
    if (Array.isArray(partitions) && partitions.length > 0) {
      continue;
    }

    const runtimeFiles = runtimeFilesByBoard.get(board.id) || [];
    if (runtimeFiles.length === 0) continue;

    const runtime = boardRuntimes.get(board.id);
    if (!runtime) continue;

    scheduleCircuitPythonInject(
      runtime.runner,
      runtimeFiles,
      () => String(boardSerialOutput.get(board.id) || ''),
      registerInjectionTimer,
      1800
    );
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

    for (const timer of injectionTimers) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    injectionTimers.length = 0;

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
