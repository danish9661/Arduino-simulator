# Universal 1x Grid Migration Strategy (Option A)

## Background & Rationale
Currently, OpenHW Studio operates on a **1.5x scaled grid** (15px pin spacing) relative to upstream Wokwi element definitions, which operate on a **1x native grid** (10px pin spacing). While the 1.5x scale provides larger touch targets and clearer visual ergonomics in the browser UI, it introduces complexity when importing third-party Wokwi projects (`diagram.json`), requiring dynamic 1.5x coordinate and waypoint scaling during import to prevent component overlap.

To achieve complete architectural purity and 1:1 upstream ecosystem alignment in a future release (e.g., Phase 6), OpenHW Studio plans to migrate the entire emulator component registry to a universal 1x grid.

## Architectural Roadmap

### 1. Registry Manifest Refactoring
Every component manifest in `openhw-studio-emulator/src/components/*` will be updated to native 1x dimensions:
- **Bounding Boxes**: Bounding dimensions (`w`, `h`) will be scaled down by 1.5x (e.g., Uno width from `311` to `207`).
- **Pin Coordinates**: All pin `x, y` positions will be scaled down by 1.5x to match the standard 10px pin spacing grid.

### 2. Legacy Project Fallback (`0.6667x` Scale)
To ensure **zero breakage of existing OpenHW Studio user projects**, a reverse scaling fallback will be implemented inside `projectUtils.js` (`normalizeImportedCircuitData`):

```javascript
function migrateLegacyOpenHWProject(circuitData) {
  const isLegacyScale = detectLegacyProject(circuitData);
  if (!isLegacyScale) return circuitData;

  const SCALE_FACTOR = 1 / 1.5; // 0.6667

  const migratedComponents = circuitData.components.map(comp => ({
    ...comp,
    x: Number(comp.x) * SCALE_FACTOR,
    y: Number(comp.y) * SCALE_FACTOR
  }));

  const migratedWires = circuitData.wires.map(wire => ({
    ...wire,
    waypoints: (wire.waypoints || []).map(wp => {
      if (Array.isArray(wp)) return [Number(wp[0]) * SCALE_FACTOR, Number(wp[1]) * SCALE_FACTOR];
      if (wp && typeof wp === 'object') return { ...wp, x: Number(wp.x) * SCALE_FACTOR, y: Number(wp.y) * SCALE_FACTOR };
      return wp;
    })
  }));

  return { components: migratedComponents, wires: migratedWires };
}
```

### 3. Benefits of Universal 1x Grid Parity
- **Seamless Interoperability**: Direct 1:1 compatibility with Wokwi `diagram.json` without any import-time mathematical scaling.
- **Simplified Custom Components**: Third-party developers creating custom SVG components can use standard Wokwi element viewBox dimensions directly.
- **Unified Mental Model**: Eliminates the cognitive overhead of maintaining two separate coordinate systems across frontend simulation and worker execution.
