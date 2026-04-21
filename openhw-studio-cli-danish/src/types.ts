export type BoardKind = 'arduino_uno' | 'esp32' | 'stm32' | 'rp2040' | 'unknown';

export interface ProjectFileEntry {
  id: string;
  path: string;
  name: string;
  kind: string;
  boardId?: string;
  boardKind?: string;
  content?: string;
  dirty?: boolean;
}

export interface ComponentEntry {
  id: string;
  type: string;
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  attrs?: Record<string, unknown>;
}

export interface WireEntry {
  id: string;
  from: string;
  to: string;
  color?: string;
  waypoints?: Array<{ x: number; y: number }>;
  isBelow?: boolean;
  fromLabel?: string;
  toLabel?: string;
}

export interface OpenHwProject {
  schemaVersion: '1.0';
  name: string;
  board: string;
  components: ComponentEntry[];
  connections: WireEntry[];
  code: string;
  blocklyXml?: string;
  blocklyGeneratedCode?: string;
  useBlocklyCode?: boolean;
  projectFiles: ProjectFileEntry[];
  openCodeTabs: string[];
  activeCodeFileId: string;
  exportedAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface SimulationBoardSummary {
  id: string;
  type: string;
}

export interface SimulationComponentSnapshot {
  id: string;
  type: string;
  label: string;
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: Record<string, unknown>;
}

export interface SimulationSnapshot {
  capturedAt: string;
  boards: SimulationBoardSummary[];
  pinsByBoard: Record<string, Record<string, boolean>>;
  components: SimulationComponentSnapshot[];
  connections: WireEntry[];
}

export interface SimulationComponentTelemetry {
  id: string;
  type: string;
  label: string;
  group: string;
  role: 'board' | 'input' | 'output' | 'other';
  status: 'ok' | 'warn' | 'error';
  updates: number;
  changedKeys: string[];
  outputSummary: string;
  telemetrySummary?: string;
  telemetryData?: Record<string, unknown>;
  universalMetrics?: Record<string, unknown>;
  notes: string[];
  lastState: Record<string, unknown>;
}

export interface SimulationTelemetryReport {
  generatedAt: string;
  elapsedMs: number;
  faults: number;
  serialChars: number;
  boards: Array<{
    id: string;
    type: string;
    serialChars: number;
    faultCount: number;
  }>;
  components: SimulationComponentTelemetry[];
}

export interface SimulationRunOptions {
  backendUrl: string;
  durationMs: number;
  debugMode: 'off' | 'text' | 'json';
  boardId?: string;
  allBoards?: boolean;
  baudRate?: number;
  serialInput?: string;
  stdinSerial?: boolean;
  stdinBoardId?: string;
  telemetryMode?: 'off' | 'text' | 'json';
}

export interface SimulationRunResult {
  elapsedMs: number;
  boardId: string;
  boardType: string;
  boardIds: string[];
  serialChars: number;
  faultCount: number;
  boardResults: Array<{
    boardId: string;
    boardType: string;
    serialChars: number;
    faultCount: number;
  }>;
  telemetry?: SimulationTelemetryReport;
}
