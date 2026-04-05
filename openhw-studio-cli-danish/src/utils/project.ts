import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ComponentEntry,
  OpenHwProject,
  ProjectFileEntry,
  ValidationIssue,
  ValidationReport,
  WireEntry,
} from '../types.js';
import {
  defaultBoardTypeForKind,
  defaultMainCode,
  defaultMainFileName,
  getBoardComponents,
  inferBoardFromComponents,
  isFileDisabled,
  normalizeBoardKind,
} from './boards.js';
import { getPinsForType, isKnownComponentType } from './manifests.js';
import { resolveWorkspacePath } from './paths.js';

const OPENHW_META_MARKER = '\u0000OPENHW_META\u0000';

function asString(value: unknown, fallback = ''): string {
  const text = typeof value === 'string' ? value : '';
  return text.trim() ? text : fallback;
}

function normalizeComponent(entry: any): ComponentEntry {
  const attrs = (entry?.attrs && typeof entry.attrs === 'object') ? entry.attrs : {};
  const fromAttrsX = Number((attrs as any).x);
  const fromAttrsY = Number((attrs as any).y);

  return {
    id: asString(entry?.id, ''),
    type: asString(entry?.type, ''),
    label: asString(entry?.label, ''),
    x: Number.isFinite(Number(entry?.x)) ? Number(entry.x) : (Number.isFinite(fromAttrsX) ? fromAttrsX : 120),
    y: Number.isFinite(Number(entry?.y)) ? Number(entry.y) : (Number.isFinite(fromAttrsY) ? fromAttrsY : 120),
    w: Number.isFinite(Number(entry?.w)) ? Number(entry.w) : 80,
    h: Number.isFinite(Number(entry?.h)) ? Number(entry.h) : 80,
    attrs,
  };
}

function normalizeWire(entry: any): WireEntry {
  return {
    id: asString(entry?.id, ''),
    from: asString(entry?.from, ''),
    to: asString(entry?.to, ''),
    color: asString(entry?.color, ''),
    waypoints: Array.isArray(entry?.waypoints)
      ? entry.waypoints
          .map((wp: any) => ({ x: Number(wp?.x), y: Number(wp?.y) }))
          .filter((wp: any) => Number.isFinite(wp.x) && Number.isFinite(wp.y))
      : [],
    isBelow: !!entry?.isBelow,
    fromLabel: asString(entry?.fromLabel, ''),
    toLabel: asString(entry?.toLabel, ''),
  };
}

function normalizeProjectFiles(files: any[]): ProjectFileEntry[] {
  const list = Array.isArray(files) ? files : [];
  const seen = new Set<string>();
  const out: ProjectFileEntry[] = [];

  for (const file of list) {
    const normalizedPath = asString(file?.path || file?.id, '');
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);

    out.push({
      id: normalizedPath,
      path: normalizedPath,
      name: asString(file?.name, path.basename(normalizedPath)),
      kind: asString(file?.kind, 'code'),
      boardId: asString(file?.boardId, ''),
      boardKind: asString(file?.boardKind, ''),
      content: typeof file?.content === 'string' ? file.content : '',
      dirty: !!file?.dirty,
    });
  }

  return out;
}

function ensureBoardFiles(project: OpenHwProject): void {
  const boardComponents = getBoardComponents(project);
  const existing = new Map(project.projectFiles.map((f) => [f.path, f]));

  for (const boardComp of boardComponents) {
    const boardKind = normalizeBoardKind(boardComp.type);
    const boardId = boardComp.id;

    const desiredFiles: Array<{ path: string; content: string }> =
      boardKind === 'rp2040'
        ? [
            { path: `project/${boardId}/${boardId}.ino`, content: defaultMainCode('arduino_uno', boardId) },
            { path: `project/${boardId}/main.py`, content: defaultMainCode('rp2040', boardId) },
          ]
        : [
            {
              path: `project/${boardId}/${defaultMainFileName(boardKind, boardId)}`,
              content: defaultMainCode(boardKind, boardId),
            },
          ];

    for (const desired of desiredFiles) {
      if (existing.has(desired.path)) continue;
      project.projectFiles.push({
        id: desired.path,
        path: desired.path,
        name: path.basename(desired.path),
        kind: 'code',
        boardId,
        boardKind,
        content: desired.content,
        dirty: false,
      });
      existing.set(desired.path, project.projectFiles[project.projectFiles.length - 1]);
    }
  }
}

function buildDiagramJson(project: OpenHwProject): string {
  return JSON.stringify(
    {
      board: project.board,
      components: project.components.map((c) => ({ id: c.id, type: c.type, attrs: c.attrs || {} })),
      connections: project.connections.map((w) => ({ id: w.id, from: w.from, to: w.to })),
    },
    null,
    2
  );
}

function upsertRootFiles(project: OpenHwProject): void {
  const diagramPath = 'project/diagram.json';
  const libraryPath = 'project/library.txt';

  const diagram = buildDiagramJson(project);
  const libraryContent = project.projectFiles
    .find((f) => f.path === libraryPath)?.content || '';

  const files = new Map(project.projectFiles.map((f) => [f.path, f]));

  if (!files.has(diagramPath)) {
    project.projectFiles.push({
      id: diagramPath,
      path: diagramPath,
      name: 'diagram.json',
      kind: 'root',
      content: diagram,
      dirty: false,
    });
  } else {
    const existing = files.get(diagramPath)!;
    existing.content = diagram;
    existing.dirty = false;
  }

  if (!files.has(libraryPath)) {
    project.projectFiles.push({
      id: libraryPath,
      path: libraryPath,
      name: 'library.txt',
      kind: 'root',
      content: libraryContent,
      dirty: false,
    });
  }
}

function inferPrimaryCode(project: OpenHwProject): string {
  const boardFiles = project.projectFiles
    .filter((f) => f.kind === 'code' && !isFileDisabled(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const firstIno = boardFiles.find((f) => f.path.toLowerCase().endsWith('.ino'));
  if (firstIno) return firstIno.content || '';

  const firstPy = boardFiles.find((f) => f.path.toLowerCase().endsWith('.py'));
  if (firstPy) return firstPy.content || '';

  return typeof project.code === 'string' ? project.code : '';
}

export function normalizeProject(rawProject: any): OpenHwProject {
  const incomingComponents = Array.isArray(rawProject?.components)
    ? rawProject.components
    : Array.isArray(rawProject?.parts)
      ? rawProject.parts
      : [];

  const incomingConnections = Array.isArray(rawProject?.connections)
    ? rawProject.connections
    : Array.isArray(rawProject?.wires)
      ? rawProject.wires
      : [];

  const components = incomingComponents
    .map(normalizeComponent)
    .filter((c: ComponentEntry) => c.id && c.type);
  const connections = incomingConnections
    .map(normalizeWire)
    .filter((w: WireEntry) => w.id && w.from && w.to);

  const board = asString(rawProject?.board, inferBoardFromComponents(components));
  const projectFiles = normalizeProjectFiles(rawProject?.projectFiles || []);

  const project: OpenHwProject = {
    schemaVersion: '1.0',
    name: asString(rawProject?.name, 'Untitled'),
    board,
    components,
    connections,
    code: asString(rawProject?.code, asString(rawProject?.userCode, '')),
    projectFiles,
    openCodeTabs: Array.isArray(rawProject?.openCodeTabs)
      ? rawProject.openCodeTabs.map((id: any) => String(id)).filter(Boolean)
      : [],
    activeCodeFileId: asString(rawProject?.activeCodeFileId, ''),
    exportedAt: asString(rawProject?.exportedAt, asString(rawProject?.exported, new Date().toISOString())),
  };

  ensureBoardFiles(project);
  upsertRootFiles(project);

  if (!project.code.trim()) {
    project.code = inferPrimaryCode(project);
  }

  if (!project.activeCodeFileId || !project.projectFiles.some((f) => f.id === project.activeCodeFileId)) {
    const firstCode = project.projectFiles.find((f) => f.kind === 'code') || project.projectFiles[0];
    project.activeCodeFileId = firstCode?.id || '';
  }

  if (project.activeCodeFileId && !project.openCodeTabs.includes(project.activeCodeFileId)) {
    project.openCodeTabs.push(project.activeCodeFileId);
  }

  return project;
}

export async function loadProject(projectPath: string): Promise<OpenHwProject> {
  const absolute = resolveWorkspacePath(projectPath);
  const raw = await fs.readFile(absolute, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeProject(parsed);
}

export async function saveProject(projectPath: string, project: OpenHwProject): Promise<void> {
  const absolute = resolveWorkspacePath(projectPath);
  const normalized = normalizeProject(project);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export function createProject(name: string, board: string): OpenHwProject {
  const boardKind = normalizeBoardKind(board);
  const boardId = 'board1';
  const boardType = defaultBoardTypeForKind(boardKind === 'unknown' ? 'arduino_uno' : boardKind);

  const project = normalizeProject({
    name: asString(name, 'Untitled'),
    board: boardKind === 'unknown' ? 'arduino_uno' : boardKind,
    components: [
      {
        id: boardId,
        type: boardType,
        label: boardId,
        x: 140,
        y: 120,
        w: 160,
        h: 120,
        attrs: {},
      },
    ],
    connections: [],
    code: defaultMainCode(boardKind === 'unknown' ? 'arduino_uno' : boardKind, boardId),
    projectFiles: [],
    openCodeTabs: [],
    activeCodeFileId: '',
  });

  return project;
}

export async function extractProjectFromPng(pngPath: string): Promise<OpenHwProject> {
  const absolute = resolveWorkspacePath(pngPath);
  const bytes = await fs.readFile(absolute);
  const markerBytes = Buffer.from(OPENHW_META_MARKER, 'utf8');
  const markerIdx = bytes.lastIndexOf(markerBytes);
  if (markerIdx < 0) {
    throw new Error('PNG does not contain OPENHW metadata marker.');
  }

  const payloadBytes = bytes.subarray(markerIdx + markerBytes.length);
  const payload = payloadBytes.toString('utf8');
  const parsed = JSON.parse(payload);
  const normalized = normalizeProject({
    ...parsed,
    exportedAt: parsed.exported || parsed.exportedAt || new Date().toISOString(),
  });

  return normalized;
}

function nextComponentId(project: OpenHwProject, type: string): string {
  const base = String(type || 'comp')
    .replace(/^wokwi-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'comp';

  let idx = 1;
  let candidate = `${base}${idx}`;
  const ids = new Set(project.components.map((c) => c.id));
  while (ids.has(candidate)) {
    idx += 1;
    candidate = `${base}${idx}`;
  }
  return candidate;
}

function nextWireId(project: OpenHwProject): string {
  const ids = new Set(project.connections.map((w) => w.id));
  let idx = 1;
  let id = `w${idx}`;
  while (ids.has(id)) {
    idx += 1;
    id = `w${idx}`;
  }
  return id;
}

export async function addComponent(
  project: OpenHwProject,
  input: {
    type: string;
    id?: string;
    x?: number;
    y?: number;
    label?: string;
    attrs?: Record<string, unknown>;
  }
): Promise<ComponentEntry> {
  const type = asString(input.type, '');
  if (!type) {
    throw new Error('Component type is required.');
  }

  const knownType = await isKnownComponentType(type);
  if (!knownType) {
    throw new Error(`Unknown component type: ${type}`);
  }

  const id = asString(input.id, '') || nextComponentId(project, type);
  if (project.components.some((c) => c.id === id)) {
    throw new Error(`Component id already exists: ${id}`);
  }

  const entry: ComponentEntry = {
    id,
    type,
    label: asString(input.label, id),
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 180,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 180,
    w: 90,
    h: 90,
    attrs: input.attrs || {},
  };

  project.components.push(entry);

  if (/(arduino|esp32|stm32|rp2040|pico)/i.test(type)) {
    ensureBoardFiles(project);
  }

  return entry;
}

async function validateEndpoint(project: OpenHwProject, endpoint: string): Promise<void> {
  const [compId, pinId] = String(endpoint || '').split(':');
  if (!compId || !pinId) {
    throw new Error(`Invalid endpoint format: ${endpoint}. Expected <componentId>:<pinId>.`);
  }

  const component = project.components.find((c) => c.id === compId);
  if (!component) {
    throw new Error(`Component not found for endpoint: ${endpoint}`);
  }

  const pins = await getPinsForType(component.type);
  if (!pins || pins.size === 0) {
    return;
  }

  if (!pins.has(pinId)) {
    throw new Error(`Pin ${pinId} does not exist on component type ${component.type}.`);
  }
}

export async function addConnection(
  project: OpenHwProject,
  input: { from: string; to: string; id?: string; color?: string }
): Promise<WireEntry> {
  const from = asString(input.from, '');
  const to = asString(input.to, '');
  if (!from || !to) {
    throw new Error('Both --from and --to endpoints are required.');
  }

  await validateEndpoint(project, from);
  await validateEndpoint(project, to);

  const id = asString(input.id, '') || nextWireId(project);
  if (project.connections.some((w) => w.id === id)) {
    throw new Error(`Wire id already exists: ${id}`);
  }

  const entry: WireEntry = {
    id,
    from,
    to,
    color: asString(input.color, '#e74c3c'),
    waypoints: [],
    isBelow: false,
    fromLabel: from.split(':')[1] || '',
    toLabel: to.split(':')[1] || '',
  };

  project.connections.push(entry);
  return entry;
}

function findBestBoardFile(project: OpenHwProject, boardId: string): ProjectFileEntry | null {
  const files = project.projectFiles
    .filter((f) => String(f.path || '').startsWith(`project/${boardId}/`))
    .filter((f) => !isFileDisabled(f.path));

  const ino = files.find((f) => f.path.toLowerCase().endsWith('.ino'));
  if (ino) return ino;
  const py = files.find((f) => f.path.toLowerCase().endsWith('.py'));
  if (py) return py;
  return files[0] || null;
}

export function setBoardCode(
  project: OpenHwProject,
  input: {
    boardId: string;
    code: string;
    filePath?: string;
  }
): ProjectFileEntry {
  const boardId = asString(input.boardId, '');
  if (!boardId) throw new Error('boardId is required.');

  const boardComp = project.components.find((c) => c.id === boardId);
  if (!boardComp) throw new Error(`Board component not found: ${boardId}`);

  const boardKind = normalizeBoardKind(boardComp.type);
  const desiredPath = asString(
    input.filePath,
    `project/${boardId}/${defaultMainFileName(boardKind === 'unknown' ? 'arduino_uno' : boardKind, boardId)}`
  );

  let file = project.projectFiles.find((f) => f.path === desiredPath);
  if (!file) {
    file = {
      id: desiredPath,
      path: desiredPath,
      name: path.basename(desiredPath),
      kind: 'code',
      boardId,
      boardKind,
      content: '',
      dirty: false,
    };
    project.projectFiles.push(file);
  }

  file.content = input.code;
  file.dirty = true;
  project.code = input.code;
  project.activeCodeFileId = file.id;
  if (!project.openCodeTabs.includes(file.id)) {
    project.openCodeTabs.push(file.id);
  }

  return file;
}

export function summarizeProject(project: OpenHwProject): Record<string, unknown> {
  const boards = getBoardComponents(project);
  return {
    name: project.name,
    board: project.board,
    schemaVersion: project.schemaVersion,
    components: project.components.length,
    connections: project.connections.length,
    boards: boards.map((b) => ({ id: b.id, type: b.type })),
    files: project.projectFiles.length,
    activeCodeFileId: project.activeCodeFileId,
    exportedAt: project.exportedAt,
  };
}

export async function validateProject(project: OpenHwProject): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(project.components) || project.components.length === 0) {
    issues.push({ level: 'warn', message: 'Project has no components.' });
  }

  const componentIds = new Set<string>();
  for (const component of project.components) {
    if (!component.id) {
      issues.push({ level: 'error', message: 'Component with empty id found.' });
      continue;
    }
    if (componentIds.has(component.id)) {
      issues.push({ level: 'error', message: `Duplicate component id: ${component.id}` });
    }
    componentIds.add(component.id);

    if (!component.type) {
      issues.push({ level: 'error', message: `Component ${component.id} has empty type.` });
    }
  }

  const wireIds = new Set<string>();
  for (const wire of project.connections) {
    if (!wire.id) {
      issues.push({ level: 'error', message: 'Connection with empty id found.' });
    } else if (wireIds.has(wire.id)) {
      issues.push({ level: 'error', message: `Duplicate connection id: ${wire.id}` });
    }
    wireIds.add(wire.id);

    for (const endpoint of [wire.from, wire.to]) {
      const [compId, pinId] = String(endpoint || '').split(':');
      if (!compId || !pinId) {
        issues.push({ level: 'error', message: `Invalid endpoint format in ${wire.id}: ${endpoint}` });
        continue;
      }

      const comp = project.components.find((c) => c.id === compId);
      if (!comp) {
        issues.push({ level: 'error', message: `Endpoint references missing component (${endpoint}) in ${wire.id}` });
        continue;
      }

      const knownPins = await getPinsForType(comp.type);
      if (knownPins && knownPins.size > 0 && !knownPins.has(pinId)) {
        issues.push({ level: 'error', message: `Unknown pin ${pinId} on ${comp.type} (${wire.id})` });
      }
    }
  }

  const boards = getBoardComponents(project);
  if (boards.length === 0) {
    issues.push({ level: 'warn', message: 'No programmable board component detected.' });
  }

  if (boards.length > 1) {
    issues.push({ level: 'warn', message: 'Multiple board components detected. Use --board-id in sim run.' });
  }

  return {
    valid: !issues.some((i) => i.level === 'error'),
    issues,
  };
}

export function getCodeForBoard(project: OpenHwProject, boardId: string): { source: string; filePath: string; isPython: boolean } {
  const boardComp = project.components.find((c) => c.id === boardId);
  if (!boardComp) {
    throw new Error(`Board component not found: ${boardId}`);
  }

  const boardFiles = project.projectFiles
    .filter((f) => String(f.path || '').startsWith(`project/${boardId}/`))
    .filter((f) => !isFileDisabled(f.path));

  const ino = boardFiles.find((f) => f.path.toLowerCase().endsWith('.ino') && String(f.content || '').trim());
  if (ino) {
    return { source: ino.content || '', filePath: ino.path, isPython: false };
  }

  const py = boardFiles.find((f) => f.path.toLowerCase().endsWith('.py') && String(f.content || '').trim());
  if (py) {
    return { source: py.content || '', filePath: py.path, isPython: true };
  }

  const best = findBestBoardFile(project, boardId);
  if (best) {
    return {
      source: best.content || project.code || '',
      filePath: best.path,
      isPython: best.path.toLowerCase().endsWith('.py'),
    };
  }

  return { source: project.code || '', filePath: '', isPython: false };
}

export function getCompileFilesForBoard(project: OpenHwProject, boardId: string): Array<{ name: string; content: string }> {
  return project.projectFiles
    .filter((f) => String(f.path || '').startsWith(`project/${boardId}/`))
    .filter((f) => !isFileDisabled(f.path))
    .filter((f) => /\.(ino|h|hpp|c|cpp)$/i.test(String(f.path || '')))
    .map((f) => ({
      name: path.basename(f.path),
      content: String(f.content || ''),
    }));
}
