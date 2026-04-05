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

export interface ManifestInfo {
  type: string;
  label: string;
  group: string;
  pins: ManifestPinInfo[];
  pinIds: Set<string>;
  hasOnEvent: boolean;
}

const MANIFEST_CACHE = new Map<string, ManifestInfo>();
let loaded = false;

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
        pins?: Array<{ id?: string; x?: number; y?: number; type?: string; description?: string }>;
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
      const logicPath = path.join(path.dirname(manifestPath), 'logic.ts');
      try {
        const logicRaw = await fs.readFile(logicPath, 'utf8');
        hasOnEvent = /\bonEvent\s*\(/.test(logicRaw);
      } catch {
        hasOnEvent = false;
      }

      MANIFEST_CACHE.set(type, {
        type,
        label: String(parsed.label || type),
        group: String(parsed.group || 'Other'),
        pins,
        pinIds,
        hasOnEvent,
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
