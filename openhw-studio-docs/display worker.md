# OffscreenCanvas Display Rendering Architecture

## Background & Goal

Currently, all display component rendering (ILI9341, SSD1306, Nokia 5110, etc.) runs on the **main thread** via React `useEffect` hooks that call `ctx.putImageData(...)` or `requestAnimationFrame`. This causes **UI stuttering** and **FPS drops** because:

1. Every simulation tick (`msg.type === 'state'`), raw pixel buffers are serialized from the Web Worker → postMessage → main thread.
2. The main thread then decodes pixels, builds `ImageData`, and writes to `<canvas>` — all on the same thread as React rendering, DOM updates, and user interaction events.

**The fix:** Move pixel painting entirely off the main thread using `OffscreenCanvas` + a dedicated Render Worker. The main thread only hands over a canvas handle once — never touches pixels again.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Main Thread                                                         │
│  ┌──────────────────┐      transferControlToOffscreen()             │
│  │  React UI        │  ────────────────────────────────────────►   │
│  │  <canvas ref>    │                                               │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
          │  postMessage({ type: 'DISPLAY_FRAME', id, buffer })
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Simulation Worker (simulation.worker.ts) - EXISTING                │
│  Generates component states, including raw pixel buffers            │
│  Routes display frames directly to Render Worker (no main thread)   │
└─────────────────────────────────────────────────────────────────────┘
          │  postMessage({ type: 'DISPLAY_FRAME', ... }, [buffer])  ← Transferable
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Render Worker (display.render.worker.ts) - NEW                     │
│  Holds OffscreenCanvas contexts for all display components          │
│  Paints frames directly using ctx.putImageData() — zero main thread │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Properties
- **Zero-copy pixel transfer:** `Uint8ClampedArray` is transferred as a `Transferable`, not cloned.
- **No main-thread painting:** The Render Worker owns all `OffscreenCanvasRenderingContext2D` objects permanently.
- **Generic DisplayRenderer interface:** Every display type (ILI9341, SSD1306, Nokia 5110, e-paper, TFT touch) implements the same `IDisplayRenderer` interface in the worker.
- **React components become shells:** The `ui.tsx` files only render the SVG PCB chrome + a `<canvas>` element. They immediately call `transferControlToOffscreen()` on mount and send the handle to the Render Worker.

---

## Display Component Classification

| Component | Current Rendering | Complexity | Priority |
|---|---|---|---|
| `openhw-ili9341` | `ctx.putImageData` (RGB→RGBA) | High — 240×320 px, 60fps | **Phase 1** |
| `openhw-ssd1306-oled` | `requestAnimationFrame` + `ctx.putImageData` | Medium — 128×64 monochrome | **Phase 1** |
| `openhw-nokia-5110` | SVG `<path>` render | Low — SVG only, no canvas | **Phase 2** (optional, keep SVG) |
| `openhw-neopixel-matrix` | `wokwi-neopixel-matrix` web component | Low — web component's own render | **Phase 2** (skip for now) |
| `openhw-lcd2004-i2c` | `wokwi-lcd2004` web component | Low — web component's own render | **Phase 2** (skip for now) |
| `openhw-lcd1602-i2c` | `wokwi-lcd1602` web component | Low — web component | **Phase 2** |
| `openhw-max7219` | SVG render | Low — SVG | **Phase 2** |
| Future: TFT Touch | Pixel buffer (same as ILI9341) | High | Supported by **Phase 1 architecture** |
| Future: e-Paper | Full-frame bitmap | High | Supported by **Phase 1 architecture** |

> **Phase 1 targets ILI9341 and SSD1306** — the two components that use `ctx.putImageData` and are the primary FPS offenders.

---

## Proposed Changes

### Phase 1 — Core Infrastructure

---

#### [NEW] `openhw-studio-emulator/src/display/IDisplayRenderer.ts`

Defines the generic interface every display renderer implements in the Render Worker.

```typescript
export interface IDisplayRenderer {
  /** Called once when the OffscreenCanvas is transferred from the main thread */
  mount(canvas: OffscreenCanvas): void;
  /** Called for every pixel/state frame from the Simulation Worker */
  paint(frame: DisplayFrame): void;
  /** Called when the simulation stops or component is removed */
  destroy(): void;
}

export interface DisplayFrame {
  compId: string;
  displayType: string;         // 'ili9341' | 'ssd1306' | 'epaper' | ...
  width: number;
  height: number;
  buffer?: ArrayBuffer;        // Raw RGBA or RGB pixel data (Transferable)
  state?: Record<string, any>; // Non-pixel state (powerOn, vram, displayOn, etc.)
  timestamp: number;
}

export interface DisplayMount {
  compId: string;
  canvas: OffscreenCanvas;
  displayType: string;
  width: number;
  height: number;
}
```

---

#### [NEW] `openhw-studio-emulator/src/display/display.render.worker.ts`

The dedicated Render Worker. Lives permanently, holds `OffscreenCanvas` contexts.

```typescript
import { IDisplayRenderer, DisplayFrame, DisplayMount } from './IDisplayRenderer';
import { ILI9341Renderer } from './renderers/ILI9341Renderer';
import { SSD1306Renderer } from './renderers/SSD1306Renderer';

const RENDERER_REGISTRY: Record<string, new () => IDisplayRenderer> = {
  ili9341: ILI9341Renderer,
  ssd1306: SSD1306Renderer,
  // Future: epaper: EPaperRenderer, tft_touch: TFTRenderer
};

const renderers = new Map<string, IDisplayRenderer>();

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === 'DISPLAY_MOUNT') {
    const { compId, canvas, displayType, width, height }: DisplayMount = e.data;
    const RendererClass = RENDERER_REGISTRY[displayType];
    if (!RendererClass) return;
    const renderer = new RendererClass();
    renderer.mount(canvas);
    renderers.set(compId, renderer);
  }

  if (type === 'DISPLAY_FRAME') {
    const frame: DisplayFrame = e.data;
    const renderer = renderers.get(frame.compId);
    renderer?.paint(frame);
  }

  if (type === 'DISPLAY_UNMOUNT') {
    const renderer = renderers.get(e.data.compId);
    renderer?.destroy();
    renderers.delete(e.data.compId);
  }

  if (type === 'DISPLAY_CLEAR_ALL') {
    renderers.forEach(r => r.destroy());
    renderers.clear();
  }
};
```

---

#### [NEW] `openhw-studio-emulator/src/display/renderers/ILI9341Renderer.ts`

Pixel painter for ILI9341 — runs entirely in the Render Worker.

```typescript
export class ILI9341Renderer implements IDisplayRenderer {
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private rgbaBuffer = new Uint8ClampedArray(240 * 320 * 4);

  mount(canvas: OffscreenCanvas) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    // Initialize alpha channel
    for (let i = 3; i < this.rgbaBuffer.length; i += 4) this.rgbaBuffer[i] = 255;
  }

  paint(frame: DisplayFrame) {
    if (!this.ctx) return;
    if (!frame.state?.powerOn || frame.state?.reset) {
      this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, 240, 320); return;
    }
    if (frame.buffer) {
      // Buffer is pre-converted to RGBA by the Simulation Worker
      const imgData = new ImageData(new Uint8ClampedArray(frame.buffer), 240, 320);
      this.ctx.putImageData(imgData, 0, 0);
    }
  }

  destroy() { this.ctx = null; }
}
```

---

#### [NEW] `openhw-studio-emulator/src/display/renderers/SSD1306Renderer.ts`

VRAM painter for SSD1306 — no more `requestAnimationFrame` on the main thread.

```typescript
export class SSD1306Renderer implements IDisplayRenderer {
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private imgData: ImageData | null = null;

  mount(canvas: OffscreenCanvas) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.imgData = new ImageData(128, 64);
    // ... initialize to dark background
  }

  paint(frame: DisplayFrame) {
    if (!this.ctx || !this.imgData) return;
    const { vram, displayOn, invert, allOn } = frame.state || {};
    if (!displayOn) { this.ctx.fillStyle = '#222'; this.ctx.fillRect(0,0,128,64); return; }
    // ... decode VRAM pages, paint pixels into imgData, ctx.putImageData(...)
  }

  destroy() { this.ctx = null; this.imgData = null; }
}
```

---

### Phase 1 — React UI Shell Changes

---

#### [MODIFY] `openhw-studio-emulator/src/components/openhw-ili9341/ui.tsx`

Remove all canvas painting logic. Become a pure shell that:
1. Renders the SVG PCB chrome
2. Places the `<canvas>` element with `ref`
3. On mount, calls `canvas.transferControlToOffscreen()` and posts `DISPLAY_MOUNT` to the Render Worker

```tsx
export const ILI9341UI = ({ state, compId, renderWorker }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !renderWorker) return;
    const offscreen = canvasRef.current.transferControlToOffscreen();
    renderWorker.postMessage(
      { type: 'DISPLAY_MOUNT', compId, canvas: offscreen, displayType: 'ili9341', width: 240, height: 320 },
      [offscreen]   // transfer ownership
    );
    return () => renderWorker.postMessage({ type: 'DISPLAY_UNMOUNT', compId });
  }, [compId, renderWorker]);

  // No more state/painting effects here! SVG chrome only.
  return ( <div>...<canvas ref={canvasRef} width={240} height={320} .../></div> );
};
```

#### [MODIFY] `openhw-studio-emulator/src/components/openhw-ssd1306-oled/ui.tsx`

Same pattern — remove the `requestAnimationFrame` loop, become a shell.

---

### Phase 1 — Simulation Worker Frame Routing

---

#### [MODIFY] `OpenHW-studio-frontend/src/worker/simulation.worker.ts`

When the Render Worker is ready (a ref/port is available), route display frames directly — **bypassing the main thread entirely** for pixel data.

The key change: when processing `msg.components` that contain display state (ILI9341, SSD1306), instead of `postMessage`-ing the full pixel buffer to the main thread, forward a `DISPLAY_FRAME` message directly to the Render Worker using a `MessageChannel` port.

```typescript
// In the postRunnerState function:
for (const comp of stateObj.components) {
  if (comp.state?.buffer && renderWorkerPort) {
    // Transfer buffer zero-copy to render worker
    const frameBuf = comp.state.buffer.buffer.slice(0);
    renderWorkerPort.postMessage({
      type: 'DISPLAY_FRAME',
      compId: comp.id,
      displayType: resolveDisplayType(comp.type),
      width: comp.state.width,
      height: comp.state.height,
      buffer: frameBuf,
      state: { powerOn: comp.state.powerOn, reset: comp.state.reset },
      timestamp: Date.now(),
    }, [frameBuf]);
    // Strip buffer from main-thread message to avoid duplicate transfer
    comp.state = { ...comp.state, buffer: null };
  }
}
```

---

### Phase 1 — Frontend Wiring

---

#### [MODIFY] `OpenHW-studio-frontend/src/pages/simulationpage/SimulatorPage.jsx`

Manage the Render Worker lifecycle:

```javascript
const renderWorkerRef = useRef(null);

// On simulation start:
const renderWorker = new Worker(new URL('../../workers/display.render.worker.ts', import.meta.url), { type: 'module' });
renderWorkerRef.current = renderWorker;

// Create a MessageChannel so the Simulation Worker can post frames directly:
const { port1, port2 } = new MessageChannel();
renderWorker.postMessage({ type: 'SET_CHANNEL_PORT', port: port1 }, [port1]);
workerRef.current.postMessage({ type: 'SET_RENDER_PORT', port: port2 }, [port2]);

// Pass renderWorkerRef down to canvas UI components via getComponentStateAttrs or context
```

Pass `renderWorker` prop to display components. The simplest approach: add it to the render registry context or pass as an additional prop in the scene rendering loop.

---

## Extensibility for Future Displays

The `IDisplayRenderer` interface and `RENDERER_REGISTRY` make adding future displays trivial:

| Future Display | Changes Required |
|---|---|
| TFT Touch (XPT2046) | Add `TFTRenderer extends ILI9341Renderer`, register as `tft_touch`. Touch events go back via the existing `workerRef.postMessage`. |
| e-Paper (SSD1680) | Add `EPaperRenderer` — handles full-frame bitmaps. Same `DisplayFrame.buffer` path. |
| HUB75 LED Matrix | Add `HUB75Renderer` — similar pixel buffer approach. |
| LVGL displays | Buffer-based, same pattern. |

**No changes needed to the infrastructure** — just add a renderer class and register it.

---

## Verification Plan

### Build Check
```bash
npm run build
```
Confirm zero TypeScript errors and no bundle size regressions.

### Manual Simulation Tests
1. **ILI9341 FPS:** Run a sketch that rapidly updates the TFT. Verify main-thread FPS no longer drops when the display is updating.
2. **SSD1306 stability:** Run SSD1306 display sketch. Verify no jitter/flicker from RAF loop contention.
3. **Multiple displays:** Run a circuit with both ILI9341 and SSD1306 simultaneously. Both should render correctly.
4. **Boot/Power-off:** Verify display goes black when `powerOn = false` or simulation stops.
5. **Hot-stop/restart:** Stop simulation and re-start. Canvas should re-transfer cleanly.

### Regression Tests
- LCD2004, Neopixel, Nokia5110 (non-OffscreenCanvas components) must render unchanged.
- Serial console, pin telemetry, sync heartbeat should be unaffected.

---

## Open Questions

> [!IMPORTANT]
> **Q1: Where should the Render Worker live in the package structure?**
> - Option A: In `openhw-studio-emulator` (alongside the display component `ui.tsx` files) — clean, co-located with the display logic.
> - Option B: In `OpenHW-studio-frontend/src/workers/` — co-located with `simulation.worker.ts`.
> - **Recommendation:** Option A, since it's part of the emulator's display contract.

> [!IMPORTANT]
> **Q2: How should `renderWorker` be passed to display component UIs?**
> - Option A: **React Context** — wrap the scene in a `DisplayRenderContext.Provider`. Clean, no prop drilling.
> - Option B: **Extra prop** — add `renderWorker` to the props passed in the `CanvasSceneLayer` rendering loop.
> - **Recommendation:** Option A (React Context) to avoid touching the `CanvasSceneLayer` render loop which calls ~100s of components.

> [!IMPORTANT]
> **Q3: Phase 2 scope — should Nokia 5110 / Neopixel / wokwi web-component displays be migrated?**
> - Nokia 5110 uses SVG `<path>` — it doesn't use canvas at all, so there's no FPS gain from moving it.
> - Neopixel/LCD2004 use internal web-component rendering — they can't be moved to OffscreenCanvas.
> - **Recommendation:** Skip Phase 2 for those components. Focus effort on canvas-based pixel displays.

> [!NOTE]
> **Browser Support:** `OffscreenCanvas` + `transferControlToOffscreen()` is supported in all modern browsers (Chrome 69+, Firefox 105+, Edge 79+, Safari 16.4+). No polyfill needed.
