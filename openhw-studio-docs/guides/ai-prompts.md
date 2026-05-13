# AI AGENT PROMPT: OpenHW Studio Component Generator

**ACT AS**: A Senior Embedded Systems & Full-Stack Engineer.
**YOUR TASK**: Generate a fully functional custom component for the OpenHW Studio simulator based on the technical specification provided below.

---

## 1. System Architecture Overview
The simulator uses a **Split-Thread Execution Model**:
1.  **Main Thread (Frontend)**: Runs the UI (React/SVG), Handles user interactions, and manages the circuit canvas.
2.  **Web Worker (Simulation Engine)**: Runs the logic in a non-blocking environment. It handles pin voltages, protocol emulation (I2C/SPI/UART + I2S bit-bang assembler), and the 16MHz AVR virtual clock.
3.  **The Sync Loop**: Every 16.6ms (60FPS), the system synchronizes the `state` object from the Web Worker to the Main Thread for UI rendering.

### 1A. Runtime Scope (Critical)
- The current simulation core is **AVR/Uno-first** (`avr8js` CPU + AVR peripherals). Component protocol hooks are driven by that runtime.
- UI may expose other board families (ESP32 / RP2040 / STM32), but protocol timing and peripheral dispatch currently follow the AVR worker path unless dedicated runners are added.
- Therefore, AI-generated components MUST be authored in a **board-agnostic pin/protocol style** (see Section 9), with graceful fallback behavior.

---

## 2. Directory Structure: The 5-File + Doc Requirement
Every component MUST have its own folder in `src/components/[id]/` with these **5 required files** plus **1 recommended folder**:

1.  **[manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/manifest.json)**: Metadata (name, type, group, **description**), dimensions (w, h), user attributes (attrs), and pin coordinates (x, y).
2.  **[ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/ui.tsx)**: A React component that renders the SVG/HTML. It receives `state` (from the worker), `attrs` (from the manifest), and `isRunning` (simulation status). It MUST export a `BOUNDS` object for the selection ring (see [Section 7F](#7f-selection-bounding-boxes-bounds-new)). Optionally also exports a `ContextMenu` component for the floating config toolbar (see [Section 5A]).
3.  **[logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/logic.ts)**: A TypeScript class extending [BaseComponent](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#1-73). This is the "brain" running in the Web Worker.
4.  **[validation.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/validation.ts)**: An object containing `rules[]` with a [check(comp, graph, validator)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-arduino-uno/validation.ts#101-121) function to ensure electrical safety.
5.  **[index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/index.ts)**: The bridge that exports the manifest, UI, `BOUNDS`, LogicClass, validation, and optionally ContextMenu.
6.  **doc/index.html** *(Recommended)*: Self-contained HTML documentation page. Automatically loaded and surfaced as a **"DOCS ↗"** button in the simulator palette when the component is imported via ZIP. See [Section 2A](#2a-docindexhtml-documentation-page) for the required template.

---
### CRITICAL: manifest.json Schema Rules
The AI MUST strictly adhere to this exact property naming convention. Do not invent properties:
1. **`label`** (String): MUST use `label` for the display name. DO NOT use `name` (this will crash the catalog filter).
2. **`description`** (String): MUST include a concise 1–2 sentence description of what the component does. Shown in the palette list view and component info panel. Persists through ZIP import automatically.
3. **`w` and `h`** (Numbers): MUST use `w` and `h` for dimensions. DO NOT use `width` or `height`. (e.g., Buzzer: `w: 68, h: 90`, Shift Register: `w: 60, h: 180`).
4. **`pins`** (Array): MUST be an Array of objects `[ { id, x, y, type } ]`. DO NOT format pins as a single Object.
5. **`group`** (String): MUST include a group (e.g., `"Displays"`, `"Inputs"`, `"Outputs"`) for the component palette. (CRITICAL: Missing group causes undefined keys in the React renderer).

---
### 2A. doc/index.html Documentation Page

The `doc/` folder contains a single `index.html` file that is a **standalone, self-contained webpage** documenting the component. When the component is imported via ZIP, the simulator reads this file and stores it in the component registry. A **"DOCS ↗"** button appears in the palette list view for that component, opening the page in a new browser tab via a Blob URL.

**Requirements:**
- Must be a single self-contained `.html` file (all CSS inline in `<style>` tags — no external dependencies)
- MUST be placed at `doc/index.html` inside the component folder

**Template (Wokwi-style Reference Layout):**
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>[component-id] Reference | OpenHW Docs</title>
<style>
    :root{--accent:#0ea5e9;--bg:#ffffff;--bg2:#f8fafc;--text:#0f172a;--text2:#475569;--border:#e2e8f0;--radius:10px}
  *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:860px;margin:0 auto;line-height:1.6}
    h1{font-size:2rem;line-height:1.2;margin-bottom:8px}
    .sub{font-size:14px;color:var(--text2);margin-bottom:16px}
    .badge{display:inline-block;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;margin-bottom:18px}
    p{color:var(--text2);margin-bottom:16px}
    h2{font-size:1.02rem;color:var(--text);margin:28px 0 10px;border-bottom:1px solid var(--border);padding-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px}
    th{background:var(--bg2);color:#334155;text-align:left;padding:8px 10px;border:1px solid var(--border)}
  td{padding:8px 10px;border:1px solid var(--border);color:var(--text)}
    pre{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:var(--radius);padding:16px;font-size:13px;overflow-x:auto;margin-bottom:16px}
    code{color:#38bdf8}
    .tip{background:#f0f9ff;border-left:3px solid var(--accent);padding:12px 14px;border-radius:0 var(--radius) var(--radius) 0;font-size:13px;color:#0c4a6e;margin-bottom:16px}
    .meta{display:grid;grid-template-columns:140px 1fr;gap:8px 12px;background:var(--bg2);border:1px solid var(--border);padding:12px;border-radius:var(--radius);margin-bottom:16px}
    .meta b{color:#334155}
</style>
</head>
<body>
<h1>[component-id] Reference</h1>
<span class="badge">[Group]</span>
<p class="sub">OpenHW Studio component reference</p>
<p>[Description — 2–3 sentences explaining what the component does and when to use it]</p>

<div class="meta">
    <b>Component ID</b><span>[component-id]</span>
    <b>Display Label</b><span>[Component Name]</span>
    <b>Category</b><span>[Group]</span>
    <b>Canvas Size</b><span>[w] x [h]</span>
</div>

<h2>Pins</h2>
<table>
  <tr><th>Pin</th><th>Type</th><th>Description</th></tr>
  <tr><td>PIN_ID</td><td>Power/Digital/Analog</td><td>What this pin does</td></tr>
</table>

<h2>Attributes</h2>
<table>
  <tr><th>Attribute</th><th>Default</th><th>Description</th></tr>
  <tr><td>attr_name</td><td>default_val</td><td>What this attribute controls</td></tr>
</table>

<h2>Wiring</h2>
<pre><code>Arduino PinXX ── [Component Pin description]</code></pre>

<h2>Example Code</h2>
<pre><code>void setup() { /* ... */ }
void loop()  { /* ... */ }</code></pre>

<div class="tip">Tip: [One useful simulation-specific tip]</div>
</body></html>
```

**ZIP Import Behaviour:**
- The simulator scans the ZIP for any file matching `doc/*.html` (case-insensitive) and stores its content as `COMPONENT_REGISTRY[type].doc`.
- The description in `manifest.json` is also stored directly on the manifest object, so it is always available via `COMPONENT_REGISTRY[type].manifest.description` — no extra wiring needed.
- If no `doc/` folder is present in the ZIP, the component still imports successfully; the "DOCS ↗" button simply does not appear.

## 3. The Logic Lifecycle ([logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/logic.ts))

You must implement these methods in the `LogicClass` which extends [BaseComponent](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#1-73):

### A. Initialization
-   [constructor(id: string, manifest: any)](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts#96-290): Initialize `this.state` here. The base constructor handles pin setup.

### B. Pin Management
-   `this.getPinVoltage(pinId: string)`: Returns current voltage (0.0 to 5.0).
-   `this.setPinVoltage(pinId: string, voltage: number)`: Drives a pin (0.0 or 5.0).

### C. Execution Hooks
-   **[onPinStateChange(pinId, isHigh, cpuCycles)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#46-49)**: (CRITICAL) Triggered only when a digital signal flips. Use for buttons, clocks, or simple triggers. This is more efficient than the update loop.
-   **[update(cpuCycles, wires, allComponents)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#38-41)**: (CONTINUOUS) Called every simulation tick. Use for analog physics, ramps, or physics-heavy simulations.
-   **[onEvent(event)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#42-45)**: Handles interactions from [ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/ui.tsx). Any UI event (click, drag) sent via [onInteract](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/pages/SimulatorPage.jsx#1368-1386) arrives here.

### D. State Synchronization
-   **`this.setState(newState)`**: Updates `this.state`. Automatically sets `stateChanged = true`.
-   **[getSyncState()](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#69-72)**: (MANDATORY) The engine calls this at 60Hz if `stateChanged` is true. Return the object used by [ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/ui.tsx) for rendering.

---

## 4. Protocol & Validation

### Protocol Reality Matrix (Read Before Implementing)
- **SPI**: Byte-oriented hardware hook exists (`onSPIByte`). CS/SS alias detection is implemented.
- **I2C**: Address phase and byte phase hooks exist; read path requires `onI2CReadByte`.
- **UART/USART**: Host serial and board-to-board routing exist, currently mapped to the primary UART path.
- **I2S**: Implemented as GPIO bit-bang frame assembler; no dedicated hardware peripheral model.
- **Realism note**: Bus timing/electrical contention are simplified. Always design component logic to be robust to coarse event timing.

### I2C Support
- **[onI2CStart(addr, read)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#50-51)**: ACK/NACK an address. `read=true` means master is reading FROM this slave. Save `addr` to validate subsequent bytes.
- **[onI2CByte(addr, data)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#51-52)**: MUST accept two arguments. Called during **write** transactions. Return `true` to ACK, `false` to NACK.
- **`onI2CReadByte(): number`** *(CRITICAL for readable slaves)*: Called by the `TWIAdapter` when the master clocks out a read byte (e.g., after `Wire.requestFrom()`). Return the next byte from the current register pointer. Without this method, all I2C reads from your slave return `0xFF`. See [Section 8G](#8g-i2c-slave-reads-always-returning-0xff).
- **[onI2CStop()](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#52-53)**: Transaction end. Reset any internal transaction state here.

**Typical I2C slave read pattern:**
```typescript
// Internal state machine
private regPtr    = 0;     // current register pointer
private readMode  = false; // track current transaction direction

onI2CStart(addr: number, read: boolean): boolean {
    if (addr !== MY_ADDRESS) return false;
    this.readMode = read;
    return true; // ACK
}

onI2CByte(addr: number, data: number): boolean {
    if (this.readMode) return true; // ignore data bytes during reads
    // First write byte = register address
    this.regPtr = data;
    return true;
}

// Called per byte during Wire.requestFrom()
onI2CReadByte(): number {
    const val = this.regs[this.regPtr];
    this.regPtr = (this.regPtr + 1) & 0xFF; // auto-increment
    return val;
}

onI2CStop(): void { /* reset transaction state if needed */ }
```

**I2C engine behavior details (important):**
- `connectToSlave()` calls `onI2CStart(addr, read)` on all components and stores the **first ACKing slave** as active read target.
- `writeByte()` calls `onI2CByte(-1, value)` on components and ACKs if any component returns `true`.
- `readByte()` pulls data from the active slave only: `onI2CReadByte()` (or legacy `readByte()`).
- `onI2CStop()` is broadcast to all components.

### SPI Support
- **[onSPIByte(data: number): number | void](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts#54-55)**: Called by the hardware SPI peripheral (`AVRSPI`) when the master transfers a byte. Return the MISO byte; return `void`/`undefined` to leave MISO unchanged.

  **CS/SS Chip-Select Awareness**: The worker only dispatches `onSPIByte` to a component when:
  - The component has **no** chip-select pin declared (always selected — single-slave wiring), OR
  - A pin named `cs`, `ce`, `ss`, `ssel`, `nss`, `csn`, `cs_n`, or `nce` (case-insensitive) is driven **LOW** (< 0.5 V).

  If you declare a `cs` pin in your manifest and `COMPONENT_PINS`, the component will only receive SPI bytes while that pin is asserted low. No extra logic needed in `onSPIByte`.

**Pin naming for SPI peripherals:**
- `csn` is recognized as chip-select alias automatically (active LOW).
- `mosi` / `miso` / `sck` are **not** required by the dispatcher for byte delivery, but SHOULD be present in manifest for clear wiring and voltage introspection.
- `gdo` / `gdo0` / `gdo2` are **not SPI control pins** in the worker; treat them as generic digital IRQ/status GPIO and handle with `onPinStateChange` + `setPinVoltage`.

**Typical SPI slave pattern (e.g. display with CS):**
```typescript
private cmdBuf: number[] = [];

onSPIByte(data: number): number {
    const dcHigh = this.getPinVoltage('dc') > 0.5; // D/C pin: HIGH=data, LOW=command
    if (dcHigh) {
        this.handleData(data);
    } else {
        this.handleCommand(data);
    }
    return 0xFF; // MISO (unused for most displays)
}
```

**Bit-bang SPI (GPIO toggling instead of hardware SPI):** Use `onPinStateChange` to detect SCK edges, sample MOSI, and drive MISO — the same way the 74HC595 shift register works.

### UART / USART Support
- The runtime exposes host serial and byte injection through the board USART path.
- Typical methods available to the runner: serial input queueing (`serialRx`, `serialRxByte`) and baud control (`setSerialBaudRate`).
- Multi-board UART routing is net-based for board TX→RX links (source TX pin to target RX pin).

**Component author guidance for UART-like modules:**
- If your module is a pure external UART peripheral, model its host-facing lines as regular GPIO or protocol bytes and keep logic tolerant of pacing jitter.
- Do not assume multiple independent hardware UART peripherals are currently emulated for every board family.

### I2S Support (Bit-Bang)
The ATmega328P has no hardware I2S peripheral; I2S devices are driven by bit-banging GPIO pins. The simulator's built-in **I2S frame assembler** runs automatically inside the pin-change propagation path and fires `onI2SFrame` once a complete audio frame has been assembled — no custom clocking logic needed in your component.

- **`onI2SFrame(channel: number, sample: number, bitsPerFrame: number): void`**: Called when a full audio frame has been collected for one channel.
  - `channel`: `0` = left (WS/LRCK **LOW**), `1` = right (WS/LRCK **HIGH**)
  - `sample`: Signed 32-bit value, **left-aligned** — shift right by `(32 - bitsPerFrame)` to get the actual PCM integer
  - `bitsPerFrame`: Bit depth for this frame (default `16`; override via `this.state.i2sBitsPerFrame`)

**Required pin names** — the assembler recognises these automatically by pin ID (case-insensitive):

| Role | Accepted pin IDs |
|---|---|
| Bit Clock (BCLK) | `bclk`, `sck`, `bit_clk`, `blck` |
| Word Select (WS/LRCK) | `ws`, `lrck`, `wsel`, `lrc` |
| Serial Data (SDATA) | `sdata`, `sdin`, `din`, `sd`, `dout`, `data` |

**Bit depth**: Defaults to 16-bit. Set `this.state.i2sBitsPerFrame = 32` (or `24`) in your constructor to override.

**Format**: Left-justified (no WS-delay). Data is sampled on the **BCLK rising edge**, MSB first.

**Typical I2S DAC/ADC pattern:**
```typescript
constructor(id: string, manifest: any) {
    super(id, manifest);
    this.state = { leftSample: 0, rightSample: 0, i2sBitsPerFrame: 16 };
}

onI2SFrame(channel: number, sample: number, bitsPerFrame: number): void {
    // Left-align → signed integer
    const pcm = (sample >> (32 - bitsPerFrame));
    if (channel === 0) {
        this.state.leftSample = pcm;
    } else {
        this.state.rightSample = pcm;
        this.setState({ leftSample: this.state.leftSample, rightSample: pcm });
    }
}
```

### Validation Engine
The `validator` (from [check](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-arduino-uno/validation.ts#101-121) function) provides:
-   `validator.calculateVoltageAtNode(pinId)`: Estimates voltage at a pin.
-   `validator.findSeriesResistance(pinId)`: Traces path to power through resistors.

---

## 5. Master Templates for AI Generation

### A. [index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/index.ts) (The Bridge)
```typescript
import manifest from './manifest.json';
import { MyUI, MyContextMenu, BOUNDS } from './ui';
import { MyLogic } from './logic';
import { validation } from './validation';
// MUST export as default object matching this exact structure:
export default {
    manifest,
    UI: MyUI,
    LogicClass: MyLogic,
    BOUNDS,                                      // ← MANDATORY: for selection box
    ContextMenu: MyContextMenu,                  // ← OPTIONAL: remove if no config menu needed
    contextMenuDuringRun: false,                 // ← OPTIONAL: set true to show during simulation
    contextMenuOnlyDuringRun: false,             // ← OPTIONAL: set true to show ONLY during simulation
    validation
};
```

### B. [logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/wokwi-led/logic.ts) Template
```typescript
import { BaseComponent } from '../BaseComponent';
export class NewComponentLogic extends BaseComponent {
    constructor(id: string, manifest: any) {
        super(id, manifest);
        // CRITICAL: attrs are passed in manifest.attrs, NOT automatically set on 'this'
        const defaultVal = manifest.attrs?.mySetting?.default ?? 0;
        this.state = { value: defaultVal };
    }
    onPinStateChange(pinId: string, isHigh: boolean) {
        if (pinId === 'PWR' && isHigh) this.setState({ value: 1 });
    }
    getSyncState() { return { ...this.state }; }
}
```

---

## 5A. Context Menus: Component Configuration UI (NEW!)

A **Context Menu** is a floating toolbar that appears above a selected component on the canvas, showing configurable properties (color, voltage, resistance, dimensions, etc.). It allows users to tweak component behavior **without opening a separate dialog**.

### Why Context Menus?
- **Immediate feedback**: Properties update in real-time as you edit
- **Non-intrusive**: No modal—the canvas stays interactive
- **Modular**: Each component defines its own menu; no hard-coded UI in the main simulator

### How to Create a Context Menu

#### Step 1: Export `ContextMenu` from `ui.tsx`
In your component's `ui.tsx`, define a React functional component with signature:
```typescript
export const YourComponentContextMenu = ({ attrs, onUpdate }) => (
    <>
        <span style={{ fontSize: 12, color: 'var(--text2)' }}>Label:</span>
        <input
            type="text"
            value={attrs?.myProperty ?? 'default'}
            onChange={e => onUpdate('myProperty', e.target.value)}
            style={{ background: 'var(--bg)', color: 'white', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px', outline: 'none' }}
        />
    </>
);
```

**Props:**
- `attrs` (Object): Current component attributes. Also includes `attrs.onInteract` for real-time communication (see [Section 7A](#7a-the-oninteract-location)).
- `onUpdate` (Function): Call `onUpdate(key, value)` to update a persistent component attribute (manifest).

**Example implementations:**
- **LED color picker** (`wokwi-led`): A `<select>` dropdown with color options
- **Resistor value** (`wokwi-resistor`): A text `<input>` + `−`/`+` buttons to step values by 10x
- **Neopixel matrix** (`wokwi-neopixel-matrix`): Two number inputs for width/height

#### Step 2: Export `ContextMenu` and Flags
Update your `index.ts`, but **CRITICAL**: For dynamic sync (ZIP uploads/Backend sync), you MUST ALSO export these flags from `ui.tsx` or include them in `manifest.json`.

**[index.ts](file:///c:/Users/Danish/Documents/simulator/component/index.ts)**:
```typescript
import manifest from './manifest.json';
import { YourUI, YourComponentContextMenu, BOUNDS } from './ui';
import { YourLogic } from './logic';
import { validation } from './validation';

export default {
    manifest,
    LogicClass: YourLogic,
    UI: YourUI,
    BOUNDS,                                           // ← MANDATORY: for selection box
    ContextMenu: YourComponentContextMenu,           // ← OPTIONAL: remove if no config menu needed
    contextMenuDuringRun: true,                       // ← SET TRUE to show during simulation
    contextMenuOnlyDuringRun: true,                   // ← SET TRUE to show ONLY during simulation
    validation
};
```

**[ui.tsx](file:///c:/Users/Danish/Documents/simulator/component/ui.tsx)** (MANDATORY for dynamic/ZIP sync):
```typescript
export const contextMenuDuringRun = true;
export const contextMenuOnlyDuringRun = true;
```

**[manifest.json](file:///c:/Users/Danish/Documents/simulator/component/manifest.json)** (Optional backup):
```json
{
  "type": "my-comp",
  "contextMenuDuringRun": true,
  "contextMenuOnlyDuringRun": true,
  ...
}
```

**Context Menu Lifecycle:**
- By default (`contextMenuDuringRun: false`, `contextMenuOnlyDuringRun: false`), the menu hides when simulation starts and shows when stopped.
- Set `contextMenuDuringRun: true` if your component allows live editing during execution (e.g., brightness slider for lights, frequency for PWM).
- Set `contextMenuOnlyDuringRun: true` if the menu should ONLY be accessible while running (e.g., sensor tuning that requires live feedback). This hides the menu when the simulation is stopped.

#### Step 3: How SimulatorPage Discovers It
The frontend automatically looks up `COMPONENT_REGISTRY[componentType].ContextMenu` when a component is selected. No manual registration needed—it works immediately once you export it.

### Context Menu Slider Pattern (2-Line Layout)
The context menu parent uses a CSS grid. To give controls full width (e.g., a slider with a label above), use `gridColumn: '1 / -1'` and wrap each slider in a flex row:
```tsx
export const MySensorContextMenu = ({ attrs, onUpdate }) => {
    const val = parseInt(attrs?.level ?? '0', 10) || 0;

    const handleChange = (v: number) => {
        onUpdate('level', v);
        attrs.onInteract?.({ type: 'SET_LEVEL', value: v });
    };

    return (
        <>
            {/* Line 1: label – spans full grid width */}
            <span style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text2)' }}>
                Level
            </span>
            {/* Line 2: slider + value – also spans full grid width */}
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                    type="range" min={0} max={255} value={val}
                    onChange={e => handleChange(parseInt(e.target.value, 10))}
                    onPointerDown={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    onTouchStart={e => e.stopPropagation()}
                    style={{ flex: 1, accentColor: '#FF0000', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 11, minWidth: 46, fontFamily: 'monospace', textAlign: 'right', flexShrink: 0 }}>
                    {((val / 255) * 50).toFixed(1)} mA
                </span>
            </div>
        </>
    );
};
```

### C. [ui.tsx] Master Template for Interactive Components (NEW!)
Use this template for ANY component that has buttons, sliders, or clickable HTML elements.
```tsx
import React, { useRef, useLayoutEffect } from 'react';

// Bounding box for selection ring.
// x, y: offset from comp.x/comp.y (top-left)
// w, h: visible width/height of the component body
export const BOUNDS = { x: 0, y: 0, w: 100, h: 50 };

export const MyInteractiveUI = ({ state, attrs, isRunning }) => {
    // 1. UI Wrapper: pointer-events: none (Crucial for pass-through to Hit Box)
    // 2. Interactive Area: pointer-events: isRunning ? 'auto' : 'none'
    // 3. Propagation: stopPropagation on all pointer/mouse events
    return (
        <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
            <div
                style={{
                    pointerEvents: isRunning ? 'auto' : 'none',
                    cursor: isRunning ? 'pointer' : 'move'
                }}
                onPointerDown={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
            >
                {/* Your SVG or HTML controls here */}
                <button onClick={() => attrs.onInteract?.('click')}>
                  {state.label || 'Action'}
                </button>
            </div>
        </div>
    );
};
```

### Styling Guidelines
- Keep the menu compact: use small font sizes (`fontSize: 12`)
- Use CSS variables: `var(--bg)`, `var(--text)`, `var(--border)` for theme consistency
- Add `onPointerDown={e => e.stopPropagation()}` to any interactive elements to prevent drag-on-canvas
- **Search Prevention**: The simulator wraps the context menu in a container with `data-contextmenu="true"` and suppresses double-click propagation automatically. You do not need to add `onDoubleClick` to the context menu components themselves unless they contain custom nested areas that bypass this wrapper.
- Rendered at `zIndex: 200` by default (above components at `zIndex: 5`)

### Real-World Example: Sensor with Real-Time Sync
```tsx
export const MySensorContextMenu = ({ attrs, onUpdate }) => {
    const value = attrs?.value ?? 500;

    const handleChange = (newVal) => {
        onUpdate('value', newVal);
        // CRITICAL: Also send to worker for immediate logic update
        attrs.onInteract?.({ type: 'SET_VAL', value: newVal });
    };

    return (
        <>
            <span style={{ fontSize: 12 }}>Tuning:</span>
            <input
                type="range" min="0" max="1000" value={value}
                onChange={e => handleChange(parseFloat(e.target.value))}
            />
        </>
    );
};
```

---

## 6. Global Registration Requirement
After generating the 5 files, the agent MUST register the component in **two places** for built-in/native components:

### A. Emulator Component Index
Add this line to [src/components/index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/index.ts):
```typescript
export { default as myNewComponent } from './my-new-component';
```

### B. Worker Registry (`execute.ts`) — CRITICAL
The Web Worker that runs the simulation must also know about your component. Add entries to **both** maps in [OpenHW-studio-frontend/src/worker/execute.ts](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts):

**1. Import the Logic class:**
```typescript
import { MyNewComponentLogic } from '@openhw/emulator/src/components/my-new-component/logic.ts';
```

**2. Add to `LOGIC_REGISTRY`** (maps component type string → Logic class):
```typescript
export const LOGIC_REGISTRY: Record<string, any> = {
    // ... existing entries ...
    'my-new-component': MyNewComponentLogic,
};
```

**3. Add to `COMPONENT_PINS`** (defines the pin IDs the worker uses for voltage tracking):
```typescript
export const COMPONENT_PINS: Record<string, { id: string }[]> = {
    // ... existing entries ...
    'my-new-component': [{ id: 'VCC' }, { id: 'GND' }, { id: 'SDA' }, { id: 'SCL' }],
};
```

> **Critical — Pin ID case must match manifest.json exactly (case-sensitive).** The `id` values in `COMPONENT_PINS` initialize `inst.pins`, and wire endpoints use the pin `id` from the manifest. A case mismatch (`"SDA"` vs `"sda"`) means `inst.pins['sda']` is never initialized, voltages are never propagated, and the component silently stops responding to bus signals. **Always copy pin `id` strings directly from your manifest.json.** See [Section 8I](#8i-component_pins-pin-id-case-mismatch).

> **Why both?** `LOGIC_REGISTRY` instantiates the logic class when a simulation starts. `COMPONENT_PINS` initialises the pin voltage map so `getPinVoltage`/`setPinVoltage` work correctly. Missing either entry causes the component to be silently ignored in the worker.

### 6C. ZIP/Sandbox Path vs Built-In Path
- **Built-in component (repo source):** Update emulator index + worker registries as above.
- **ZIP/custom component path:** Worker can inject logic dynamically (`customLogics`) and populate `LOGIC_REGISTRY` / `COMPONENT_PINS` at runtime.
- For portability, always keep `manifest.pins` IDs identical to runtime pin IDs and avoid relying on implicit aliases.

---

## 7. UI Controls & Canvas Interaction (ui.tsx)
If the component includes interactive HTML elements (like `<input>`, `<button>`, or sliders) overlaying the SVG, the AI MUST follow these rules to prevent canvas freezing:

### A. The `onInteract` Location & Sync Flags
1. **Callbacks**: The interaction callback is passed inside the `attrs` object, NOT as a top-level prop.
   - **CORRECT**: `attrs.onInteract({ type: 'SET_VAL', value: 10 })`
   - **WRONG**: `onInteract({ ... })`

2. **Sync Flags**: Flags like `contextMenuDuringRun` or `contextMenuOnlyDuringRun` MUST be exported from `ui.tsx` (e.g., `export const contextMenuDuringRun = true;`) or defined in `manifest.json` to be recognized by the frontend's dynamic synchronization loader (ZIP uploads & approved backend components). `index.ts` exports are primarily for built-in components.

### B. Punching Through the Canvas Lock
When the simulation runs, the canvas locks components with CSS. To make custom HTML controls clickable during simulation:
1.  **UI Wrapper**: The top-level `div` in `ui.tsx` MUST have `style={{ pointerEvents: 'none' }}`.
2.  **Interactive Elements**: Individual buttons, sliders, or inputs MUST have `style={{ pointerEvents: isRunning ? 'auto' : 'none' }}`.
This ensures that when simulation is stopped, the underlying **Hit Box** (defined by `BOUNDS`) captures all clicks for dragging/selection, but when running, the specific controls become interactive.

### C. Stopping Drag Propagation
HTML inputs must prevent mouse events from bubbling up to the canvas, otherwise, clicking the input will drag the component. Add these to all inputs:
`onPointerDown={(e) => e.stopPropagation()}`
`onMouseDown={(e) => e.stopPropagation()}`
`onTouchStart={(e) => e.stopPropagation()}`

### D. Double-Click Search Prevention
Double-clicking on the empty canvas triggers the **Quick Add** search menu. To prevent this when interacting with your component's controls:
1.  **Standard Tags**: The simulator automatically ignores double-clicks on `input`, `textarea`, `button`, and `select` tags.
2.  **Custom Elements**: If you use custom clickable elements (like a `div` acting as a button or a slider wrapper), you MUST add:
    `onDoubleClick={(e) => e.stopPropagation()}`
3.  **Automatic Protection**: The simulator already handles double-click suppression for:
    - The main component body.
    - Wires and pins.
    - Context Menus (any click inside an element with `[data-contextmenu]` is automatically protected; the simulator handles this for the `ContextMenu` export).

### E. List Rendering & React Keys
When mapping over arrays in `ui.tsx` (e.g., for pins, LEDs, or segments), ALWAYS use robust, unique keys.
- **BAD**: `key={index}` (Can cause rendering glitches if the list order changes).
- **GOOD**: `key={item.id}` or `key={`${item.type}-${index}`}`. (Ensures React correctly tracks each element).

### F. Selection & Bounding Boxes (BOUNDS) [UPDATED]
To render the blue selection ring and error indicators accurately, every component's `ui.tsx` MUST export a `BOUNDS` property. This can be a static object or a **dynamic function** (for components that change size based on attributes like Neopixel Matrices).

#### Static Bounds
```typescript
export const BOUNDS = { x: 0, y: 0, w: W, h: H };
```
- **`x`, `y`**: The top-left offset from the component's base coordinates (`comp.x`, `comp.y`) where the visual area actually starts. Usually `{0,0}`.
- **`w`, `h`**: The visible width and height of the component's SVG/HTML body.

#### Dynamic Bounds (Function)
If the component's visual footprint changes based on user attributes (e.g., changing rows/cols in a Context Menu), use a function:
```typescript
export const BOUNDS = (attrs: any) => {
    const cols = parseInt(attrs?.cols || '1', 10);
    const rows = parseInt(attrs?.rows || '1', 10);
    // Return the bounds relative to the internal SVG/HTML coordinate system
    return {
        x: 0,
        y: 0,
        w: Math.max(20, cols * 25),
        h: Math.max(20, rows * 25)
    };
};
```

### G. Virtual Area vs. Selection Box
Every component has two sets of dimensions:
1.  **Manifest `w`, `h` (The Virtual Area)**: Defines the total interactive footprint of the component. This is the "wrapper" `div` that handles drag events. It should include everything, including protruding parts like USB plugs or headers.
2.  **`BOUNDS` (The Selection Box & Hit Box)**:
    - **Visual**:Defines the geometric area for the blue selection ring and error indicators. This should usually tightly wrap the "main body" or PCB of the component.
    The simulator now positions the component label automatically based on `BOUNDS.h`, so the label will always stay close to the component's body regardless of how large the manifest's interactive "virtual area" is.
    - **Interaction**: Acts as a **Hit Box**. Only clicks/drags within this area (and on pins) are captured by the component.
    - **Pass-through**: Clicks in the "Virtual Area" *outside* the `BOUNDS` will pass through to the canvas, allowing panning or quick-add search to trigger even if technically over the component's manifest footprint.

The simulator now positions the component label automatically based on `BOUNDS.h`.
Selection box is calculated as: `left: b.x-6, top: b.y-6, width: b.w+12, height: b.h+12`.
Label is placed 4px below the bottom of the `BOUNDS` area.

The simulator reads this via the registry:
`const b = COMPONENT_REGISTRY[comp.type]?.BOUNDS || { x: 0, y: 0, w: comp.w, h: comp.h };`

---

## 8. Advanced Display & Protocol Gotchas

### A. I2C Signature Mismatch
The `AVRRunner` passes `(addr, data)` to `onI2CByte`. If your logic only accepts one argument, the hardware `addr` (usually -1 for MCU writes) will be treated as `data`, resulting in a screen filled with white pixels (0xFF).
- **FIX**: `onI2CByte(addr: number, data: number) { ... }`

### B. Display Orientation
Standard SSD1306 modules are physically 180-degrees rotated relative to their pins at the top.
- **PITFALL**: Native A0/C0 orientation will appear upside-down.
- **FIX**: Invert the coordinate mapping in `ui.tsx` so that standard library "Correction" commands (A1/C8) result in an upright display.

### C. Canvas Performance
Calling `ctx.createImageData` inside `requestAnimationFrame` causes severe GC pressure and 60FPS stutter.
- **FIX**: Pre-allocate `ImageData` once in a `useRef` or inside `useEffect` and reuse it.

### D. High-Speed Display Synchronization (VRAM Sync)
For large displays (like ILI9341 320x240), sending small pixel "batches" often results in horizontal black bands because the bridge skips rapid intermediate updates.
- **THE FIX**: Use **Full VRAM Synchronization**. Maintain a `Uint8Array` of the entire screen in the worker and send the *entire buffer* at once every 60Hz.
- **Manual Trigger**: Set `this.stateChanged = true` in the `update()` loop whenever the buffer is dirty. This bypasses the bridge's reference-equality check.

### E. Flicker-Free Stable Rendering (Evergreen Loop)
If the UI render loop restarts on every `state` update, the screen will flicker or stutter.
- **THE FIX**: Use a **Decoupled Render Loop**. Define the `requestAnimationFrame` loop once in a `useEffect([])` and make it read from a `useRef(state)`. This keeps the canvas update thread independent of React's state sync frequency.

### F. Simulation Stop Detection (Heartbeat)
Displays often "stick" on their last state when the simulation stops.
- **THE FIX**: Implement a **Heartbeat**. Include a timestamp `t: Date.now()` in every state update. In the UI render loop, check `Date.now() - lastUpdate > 800ms`. If true, the simulation has stopped; clear the screen to black.

### G. I2C Slave Reads Always Returning 0xFF
If your I2C sensor is detected as "not found" by an Arduino library (e.g., SparkFun's `begin()` returns false), or all register reads return `0xFF`, you are missing the `onI2CReadByte()` method.

**Root cause**: The `TWIAdapter` in `execute.ts` tracks the active slave in `connectToSlave()`. When the master calls `Wire.requestFrom()`, the adapter calls `onI2CReadByte()` on the active slave once per byte. If the method is absent, `0xFF` is returned unconditionally.

```
Wire.requestFrom(0x57, 1) Flow:
  connectToSlave(0x57, write=false) → onI2CStart(0x57, read=true) → activeSlave = myComp
  readByte(ack)                     → activeSlave.onI2CReadByte()  → returns regs[regPtr]
```

- **FIX**: Implement `onI2CReadByte(): number` (and optionally alias `readByte(): number`) on your Logic class. The method must return the next byte at the current register pointer and advance it.
- This was a **framework-level bug** that has been fixed in `execute.ts`. All I2C readable components now work correctly as long as they implement `onI2CReadByte()`.

### H. I2C Mode Register — Support All Active Modes
Some Arduino libraries (e.g., SparkFun MAX30105) set the chip mode to **multi-LED mode (`0x07`)** by default, not just HR (`0x02`) or SpO2 (`0x03`). If your logic guards FIFO generation or LED activation behind `mode === 0x02 || mode === 0x03`, it will silently do nothing when the library uses mode `0x07`.

- **FIX**: Check all relevant mode values: `(mode === 0x02 || mode === 0x03 || mode === 0x07)`.
- General rule: read what mode the library actually writes to the mode register using the Arduino Serial monitor, then ensure your logic handles that value.

### I. COMPONENT_PINS Pin ID Case Mismatch
**Symptom**: The component instantiates successfully, but `onPinStateChange` is never called, I2S/SPI events are silently dropped, or the pin always reads 0 V even when wired.

**Root cause**: `COMPONENT_PINS` initialises `inst.pins` with the IDs you provide. Wires and the propagation engine look up pins by the exact ID string from the manifest. If your manifest has `{ "id": "sda" }` but `COMPONENT_PINS` declares `{ id: 'SDA' }`, then `inst.pins['sda']` does not exist and `setPinVoltage('sda', …)` silently does nothing.

```typescript
// manifest.json: { "id": "sda" }  → lowercase in manifest
// BAD — COMPONENT_PINS uses wrong case:
'my-sensor': [{ id: 'SDA' }, { id: 'SCL' }]   // inst.pins['sda'] is undefined

// GOOD — must match manifest exactly:
'my-sensor': [{ id: 'sda' }, { id: 'scl' }]   // inst.pins['sda'] = { voltage: 0, mode: 'INPUT' }
```

- **FIX**: Copy pin `id` strings verbatim from your `manifest.json` pins array into `COMPONENT_PINS`. Do not change casing.

### J. `onSPIByte` Not Firing — CS/SS Pin Not Asserted
**Symptom**: You wired MOSI/SCK to your component, but `onSPIByte` is never called.

**Root cause**: The worker's SPI dispatcher (`isSPISelected`) checks if the component has a chip-select pin. If a pin named `cs`, `ce`, `ss`, `ssel`, `nss`, `csn`, `cs_n`, or `nce` exists in `inst.pins`, the component is **only** called when that pin is at < 0.5 V. If your CS pin is not wired or is floating HIGH, `onSPIByte` is skipped.

```
Checklist:
[YES] CS pin wired to an Arduino digital output
[YES] Arduino code pulls CS LOW before SPI.transfer()
[YES] Arduino code pulls CS HIGH after transfer (releases the bus)
```

If your component has no chip-select (e.g., 74HC595 — uses RCLK as latch, no CS), **do not add a CS/SS pin** to your manifest or `COMPONENT_PINS`. The dispatcher will always call `onSPIByte` for such components.

### K. I2S `onI2SFrame` Never Called
**Symptom**: You wired up an I2S device, but `onI2SFrame` is never fired.

**Checklist**:
1. **Pin names must match the assembler's known aliases** (case-insensitive). Use `bclk`, `ws`, and `sdata` (or any alias from the table in [Section 4](#i2s-support-bit-bang)). Custom names like `clock` or `lr` will not be detected.
2. **`onI2SFrame` must be declared on the class**. The assembler checks `if (!inst.onI2SFrame) return` first. If the method is not defined, the state machine is never set up.
3. **BCLK must be wired to an Arduino digital output pin** (port B/C/D). The propagation engine only fires for pins driven by the Arduino's port listeners. BCLK driven by another component's output currently does not trigger the assembler.
4. **Bit depth**: If your device uses 32-bit frames, set `this.state.i2sBitsPerFrame = 32` in the constructor. The default is 16; if 32 bits are clocked for each WS phase and the depth is left at 16, two frames will fire per channel per beat.

### L. SPI Realism Limits (Know Before Modeling Radios)
**Symptom**: Device works in simple demos but diverges from hardware behavior under multi-slave or contention-heavy scenarios.

**Current simplifications:**
1. SPI delivery is byte-dispatch based; detailed edge-level timing is abstracted.
2. If multiple selected components return MISO bytes in one transfer, last processed responder can win.
3. Worker includes convenience MISO fallbacks (loopback/derived patterns) that are helpful for debugging but are not strict electrical modeling.

**Guideline:**
- For strict protocol chips (radios/flash), keep internal state machine deterministic and avoid assumptions about exact sub-cycle timing.
- Use explicit CSN gating in your own logic even though dispatcher already filters by CS aliases.

### M. UART Realism Limits
**Symptom**: Exact framing/overrun/parity edge-cases from silicon are not reproduced 1:1.

**Current behavior:**
- Byte pacing follows baud budget approximation (`baud / 10` bytes/sec model for 8N1 throughput).
- Board-to-board routing currently targets the primary TX/RX pin mapping path.

**Guideline:**
- Build components to consume/emit bytes robustly and tolerate minor timing granularity.

### N. Board Family Support Status (ESP32 / Pico / STM32)
**Critical reality:**
- Current worker execution is AVR/Uno-centric; protocol hooks are guaranteed through that path.
- Treat ESP32/RP2040/STM32 as **forward-compatible targets** unless dedicated board runners/peripherals are present.

**AI generation rule for cross-board-ready components:**
1. Keep protocol logic board-neutral (operate on component pin IDs and protocol hooks, not board numeric pin constants).
2. Define clear pin aliases in docs (example: `cs|csn|nss`, `sda|sdio`, `irq|gdo0`).
3. Provide fallback mode in docs/code comments: if hardware SPI/I2C hook is absent for a board, bit-bang via `onPinStateChange`.
4. Avoid hardcoding Uno-only wiring statements in manifest descriptions; list protocol roles instead.

## 9. Cross-Board Authoring Standard (New)
To make components reusable across Arduino Uno, ESP32, RP2040/Pico, and STM32 families, always follow this standard:

### 9A. Pin Contract First
- In `manifest.json`, name pins by **signal role** where possible (`SDA`, `SCL`, `MOSI`, `MISO`, `SCK`, `CSN`, `IRQ/GDO`).
- Add descriptions that explain electrical direction and voltage expectations.

### 9B. Protocol + GPIO Hybrid Design
- Implement hardware protocol hook (`onSPIByte`, `onI2C*`) when available.
- Also implement `onPinStateChange` fallback for bit-bang compatibility on non-AVR runners.

### 9C. Voltage and Level-Shifting Discipline
- Validate over-voltage on low-voltage buses (3.3 V parts attached to 5 V boards).
- In validation rules, emit actionable errors for missing pull-ups, illegal direct drive, and missing CS assertion.

### 9D. Deterministic State Machine
- Maintain explicit transaction state (`selected`, `mode`, `regPtr`, `rxBuf`, `txBuf`, `irqPending`).
- Reset transient transaction state in STOP/de-select transitions.

### 9E. Multi-Board Docs Requirement
- `doc/index.html` must include one wiring table row per board family (Uno, ESP32, RP2040/Pico, STM32), using protocol role labels rather than fixed pin numbers when uncertain.

### 9F. Final AI Self-Check Before Output
- Pin IDs match exactly between `manifest.json` and worker registration.
- CS/SS alias handled (`csn` recommended for active-low radios).
- `gdo/irq` modeled as GPIO event pin, not as SPI byte lane.
- I2C read path includes `onI2CReadByte`.
- Component still behaves sensibly if only GPIO events are available.

**NOW READY**: Tell the AI agent what component you want, and instruct it to follow the "OpenHW Studio 5-File Component Pattern" defined in this manual.

**Supported bus protocols:**
- **I2C** — hardware peripheral (`AVRTWI`); implement `onI2CStart` / `onI2CByte` / `onI2CReadByte` / `onI2CStop`
- **SPI** — hardware peripheral (`AVRSPI`); implement `onSPIByte`; CS/SS pin (active-LOW) is honoured automatically
- **UART** — USART byte stream with baud-paced host injection and optional board-to-board routing on primary TX/RX path
- **I2S** — bit-bang assembler; implement `onI2SFrame`; name pins `bclk`, `ws`, `sdata` (see Section 4)
- **GPIO / ADC / PWM** — `onPinStateChange` + `update()` loop

**Board note:** AVR/Uno path is currently the reference implementation for protocol peripherals. For ESP32/Pico/STM32 compatibility, follow Section 9 hybrid strategy.

To add a floating context menu with configurable properties, see [Section 5A](#5a-context-menus-component-configuration-ui-new).


