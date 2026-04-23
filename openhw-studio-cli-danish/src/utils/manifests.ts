import fs from 'node:fs/promises';
import path from 'node:path';
import { EMULATOR_ROOT } from './paths.js';

export interface ManifestPinInfo {
  id: string;
  x?: number;
  y?: number;
  type?: string;
  description?: string;
}

export interface ManifestTelemetryInfo {
  template?: string;
  criticalKeys: string[];
}

export interface ManifestAttrInfo {
  label?: string;
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
}

export interface ManifestInteractionInfo {
  eventTypes: string[];
  contextMenuDuringRun: boolean;
  contextMenuOnlyDuringRun: boolean;
  controlKeys: string[];
  uiEventTemplates: Array<string | Record<string, unknown>>;
}

export interface ManifestInfo {
  type: string;
  label: string;
  group: string;
  pins: ManifestPinInfo[];
  pinIds: Set<string>;
  attrs: Record<string, ManifestAttrInfo>;
  hasOnEvent: boolean;
  interaction?: ManifestInteractionInfo;
  telemetry?: ManifestTelemetryInfo;
}

const MANIFEST_CACHE = new Map<string, ManifestInfo>();
let loaded = false;

function parseLogicEventTypes(logicRaw: string): string[] {
  const events = new Set<string>();

  const caseRegex = /case\s+['"`]([^'"`]+)['"`]\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(logicRaw))) {
    const eventType = String(match[1] || '').trim();
    if (eventType) events.add(eventType);
  }

  const equalsRegex = /event(?:\??\.type)?\s*===\s*['"`]([^'"`]+)['"`]/g;
  while ((match = equalsRegex.exec(logicRaw))) {
    const eventType = String(match[1] || '').trim();
    if (eventType) events.add(eventType);
  }

  return [...events].sort((a, b) => a.localeCompare(b));
}

function parseControlKeysFromUi(uiRaw: string): string[] {
  const keys = new Set<string>();
  const keyRegex = /(?:handleSlider|onUpdate)\(\s*['"`]([^'"`]+)['"`]\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(uiRaw))) {
    const key = String(match[1] || '').trim();
    if (key) keys.add(key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function parseUiEventTemplates(
  uiRaw: string,
  attrs: Record<string, ManifestAttrInfo>
): Array<string | Record<string, unknown>> {
  const templates: Array<string | Record<string, unknown>> = [];
  const onInteractRegex = /onInteract(?:\?\.|)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = onInteractRegex.exec(uiRaw))) {
    const body = String(match[1] || '');
    const typeMatch = /type:\s*['"`]([^'"`]+)['"`]/.exec(body);
    const type = String(typeMatch?.[1] || '').trim();
    if (!type) continue;

    const keyMatch = /key:\s*['"`]([^'"`]+)['"`]/.exec(body);
    const key = String(keyMatch?.[1] || '').trim();
    const template: Record<string, unknown> = { type };

    if (key) {
      template.key = key;
      template.value = attrs[key]?.default ?? 0;
    } else {
      template.value = 0;
    }

    templates.push(template);
  }

  const dedup = new Set<string>();
  return templates.filter((entry) => {
    const key = JSON.stringify(entry);
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });
}

function parseContextFlag(raw: string, key: 'contextMenuDuringRun' | 'contextMenuOnlyDuringRun'): boolean | null {
  const trueRegex = new RegExp(`${key}\\s*:\\s*true`);
  if (trueRegex.test(raw)) return true;
  const falseRegex = new RegExp(`${key}\\s*:\\s*false`);
  if (falseRegex.test(raw)) return false;
  return null;
}

async function walk(dirPath: string, output: string[]): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walk(full, output);
      continue;
    }
    if (entry.isFile() && entry.name === 'manifest.json') {
      output.push(full);
    }
  }
}

async function loadAllManifests(): Promise<void> {
  if (loaded) return;

  const manifests: string[] = [];
  const root = path.join(EMULATOR_ROOT, 'src', 'components');
  await walk(root, manifests);

  for (const manifestPath of manifests) {
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        type?: string;
        label?: string;
        group?: string;
        attrs?: Record<string, unknown>;
        contextMenuDuringRun?: unknown;
        contextMenuOnlyDuringRun?: unknown;
        pins?: Array<{ id?: string; x?: number; y?: number; type?: string; description?: string }>;
        telemetry?: {
          template?: unknown;
          criticalKeys?: unknown;
        };
      };
      const type = String(parsed.type || '').trim();
      if (!type) continue;

      const pins: ManifestPinInfo[] = [];
      const pinIds = new Set<string>();
      for (const pin of parsed.pins || []) {
        const pinId = String(pin?.id || '').trim();
        if (!pinId) continue;
        pinIds.add(pinId);
        pins.push({
          id: pinId,
          x: Number.isFinite(Number(pin?.x)) ? Number(pin?.x) : undefined,
          y: Number.isFinite(Number(pin?.y)) ? Number(pin?.y) : undefined,
          type: typeof pin?.type === 'string' ? pin.type : undefined,
          description: typeof pin?.description === 'string' ? pin.description : undefined,
        });
      }

      let hasOnEvent = false;
      let eventTypes: string[] = [];
      const logicPath = path.join(path.dirname(manifestPath), 'logic.ts');
      try {
        const logicRaw = await fs.readFile(logicPath, 'utf8');
        hasOnEvent = /\bonEvent\s*\(/.test(logicRaw);
        if (hasOnEvent) {
          eventTypes = parseLogicEventTypes(logicRaw);
        }
      } catch {
        hasOnEvent = false;
        eventTypes = [];
      }

      const attrsRaw = parsed.attrs && typeof parsed.attrs === 'object' && !Array.isArray(parsed.attrs)
        ? (parsed.attrs as Record<string, unknown>)
        : {};
      const attrs: Record<string, ManifestAttrInfo> = {};
      for (const [attrKey, attrValue] of Object.entries(attrsRaw)) {
        if (!attrKey) continue;
        if (attrValue && typeof attrValue === 'object' && !Array.isArray(attrValue)) {
          const src = attrValue as Record<string, unknown>;
          attrs[attrKey] = {
            label: typeof src.label === 'string' ? src.label : undefined,
            type: typeof src.type === 'string' ? src.type : undefined,
            default: src.default,
            min: Number.isFinite(Number(src.min)) ? Number(src.min) : undefined,
            max: Number.isFinite(Number(src.max)) ? Number(src.max) : undefined,
            step: Number.isFinite(Number(src.step)) ? Number(src.step) : undefined,
          };
          continue;
        }
        attrs[attrKey] = { default: attrValue };
      }

      let indexRaw = '';
      try {
        indexRaw = await fs.readFile(path.join(path.dirname(manifestPath), 'index.ts'), 'utf8');
      } catch {
        indexRaw = '';
      }

      let uiRaw = '';
      for (const fileName of ['ui.tsx', 'ui.ts']) {
        try {
          uiRaw = await fs.readFile(path.join(path.dirname(manifestPath), fileName), 'utf8');
          break;
        } catch {
          // Try next UI filename.
        }
      }

      const uiEventTemplates = uiRaw ? parseUiEventTemplates(uiRaw, attrs) : [];
      const controlKeys = uiRaw ? parseControlKeysFromUi(uiRaw) : [];
      const interactionEventTypes = [...new Set<string>([
        ...eventTypes,
        ...uiEventTemplates
          .map((entry) => (entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).type || '').trim() : ''))
          .filter(Boolean),
      ])].sort((a, b) => a.localeCompare(b));

      const manifestContextMenuDuringRun =
        typeof parsed.contextMenuDuringRun === 'boolean' ? parsed.contextMenuDuringRun : null;
      const manifestContextMenuOnlyDuringRun =
        typeof parsed.contextMenuOnlyDuringRun === 'boolean' ? parsed.contextMenuOnlyDuringRun : null;
      const indexContextMenuDuringRun = indexRaw ? parseContextFlag(indexRaw, 'contextMenuDuringRun') : null;
      const indexContextMenuOnlyDuringRun = indexRaw ? parseContextFlag(indexRaw, 'contextMenuOnlyDuringRun') : null;

      const contextMenuDuringRun = manifestContextMenuDuringRun ?? indexContextMenuDuringRun ?? false;
      const contextMenuOnlyDuringRun = manifestContextMenuOnlyDuringRun ?? indexContextMenuOnlyDuringRun ?? false;

      const telemetryRaw = parsed.telemetry;
      const telemetry = telemetryRaw && typeof telemetryRaw === 'object'
        ? {
            template: typeof telemetryRaw.template === 'string' ? telemetryRaw.template : undefined,
            criticalKeys: Array.isArray(telemetryRaw.criticalKeys)
              ? telemetryRaw.criticalKeys.map((key) => String(key || '').trim()).filter(Boolean)
              : [],
          }
        : undefined;

      MANIFEST_CACHE.set(type, {
        type,
        label: String(parsed.label || type),
        group: String(parsed.group || 'Other'),
        pins,
        pinIds,
        attrs,
        hasOnEvent,
        interaction: (hasOnEvent || uiEventTemplates.length > 0 || controlKeys.length > 0 || contextMenuDuringRun || contextMenuOnlyDuringRun)
          ? {
              eventTypes: interactionEventTypes,
              contextMenuDuringRun,
              contextMenuOnlyDuringRun,
              controlKeys,
              uiEventTemplates,
            }
          : undefined,
        telemetry,
      });
    } catch {
      // Ignore malformed or missing manifests.
    }
  }

  loaded = true;
}

export async function getPinsForType(type: string): Promise<Set<string> | null> {
  await loadAllManifests();
  const info = MANIFEST_CACHE.get(type);
  return info?.pinIds || null;
}

export async function getManifestInfo(type: string): Promise<ManifestInfo | null> {
  await loadAllManifests();
  return MANIFEST_CACHE.get(type) || null;
}

export async function isKnownComponentType(type: string): Promise<boolean> {
  await loadAllManifests();
  return MANIFEST_CACHE.has(type);
}

export async function listKnownComponentTypes(): Promise<string[]> {
  await loadAllManifests();
  return [...MANIFEST_CACHE.keys()].sort((a, b) => a.localeCompare(b));
}

export async function listManifestInfos(): Promise<ManifestInfo[]> {
  await loadAllManifests();
  return [...MANIFEST_CACHE.values()].sort((a, b) => a.type.localeCompare(b.type));
}
