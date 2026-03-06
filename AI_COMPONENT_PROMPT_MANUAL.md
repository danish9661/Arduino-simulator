# AI AGENT PROMPT: OpenHW Studio Component Generator

**ACT AS**: A Senior Embedded Systems & Full-Stack Engineer.
**YOUR TASK**: Generate a fully functional custom component for the OpenHW Studio simulator based on the technical specification provided below.

---

## 1. System Architecture Overview
The simulator uses a **Split-Thread Execution Model**:
1.  **Main Thread (Frontend)**: Runs the UI (React/SVG), Handles user interactions, and manages the circuit canvas.
2.  **Web Worker (Simulation Engine)**: Runs the logic in a non-blocking environment. It handles pin voltages, protocol emulation (I2C/SPI), and the 16MHz AVR virtual clock.
3.  **The Sync Loop**: Every 16.6ms (60FPS), the system synchronizes the `state` object from the Web Worker to the Main Thread for UI rendering.

---

## 2. Directory Structure: The 5-File Requirement
Every component MUST have its own folder in `src/components/[id]/` with these 5 files:

1.  **[manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/manifest.json)**: Metadata (name, type, group), dimensions (w, h), user attributes (attrs), and pin coordinates (x, y).
2.  **[ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/ui.tsx)**: A React component that renders the SVG/HTML. It receives `state` (from the worker) and `attrs` (from the manifest).
3.  **[logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/logic.ts)**: A TypeScript class extending [BaseComponent](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#1-73). This is the "brain" running in the Web Worker.
4.  **[validation.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/validation.ts)**: An object containing `rules[]` with a [check(comp, graph, validator)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-arduino-uno/validation.ts#101-121) function to ensure electrical safety.
5.  **[index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/index.ts)**: The bridge that exports the manifest, UI, LogicClass, and validation as a single module.

---
### CRITICAL: manifest.json Schema Rules
The AI MUST strictly adhere to this exact property naming convention. Do not invent properties:
1. **`label`** (String): MUST use `label` for the display name. DO NOT use `name` (this will crash the catalog filter).
2. **`w` and `h`** (Numbers): MUST use `w` and `h` for dimensions. DO NOT use `width` or `height`.
3. **`pins`** (Array): MUST be an Array of objects `[ { id, x, y, type } ]`. DO NOT format pins as a single Object.

## 3. The Logic Lifecycle ([logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/logic.ts))

You must implement these methods in the `LogicClass` which extends [BaseComponent](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#1-73):

### A. Initialization
-   [constructor(id: string, manifest: any)](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend-danish/src/worker/execute.ts#96-290): Initialize `this.state` here. The base constructor handles pin setup.

### B. Pin Management
-   `this.getPinVoltage(pinId: string)`: Returns current voltage (0.0 to 5.0).
-   `this.setPinVoltage(pinId: string, voltage: number)`: Drives a pin (0.0 or 5.0).

### C. Execution Hooks
-   **[onPinStateChange(pinId, isHigh, cpuCycles)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#46-49)**: (CRITICAL) Triggered only when a digital signal flips. Use for buttons, clocks, or simple triggers. This is more efficient than the update loop.
-   **[update(cpuCycles, wires, allComponents)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#38-41)**: (CONTINUOUS) Called every simulation tick. Use for analog physics, ramps, or physics-heavy simulations.
-   **[onEvent(event)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#42-45)**: Handles interactions from [ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/ui.tsx). Any UI event (click, drag) sent via [onInteract](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend-danish/src/pages/SimulatorPage.jsx#1368-1386) arrives here.

### D. State Synchronization
-   **`this.setState(newState)`**: Updates `this.state`. Automatically sets `stateChanged = true`.
-   **[getSyncState()](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#69-72)**: (MANDATORY) The engine calls this at 60Hz if `stateChanged` is true. Return the object used by [ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/ui.tsx) for rendering.

---

## 4. Protocol & Validation

### I2C & SPI Support
- [onI2CStart(addr, read)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#50-51): ACK/NACK an address.
- **[onI2CByte(addr, data)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#51-52)**: MUST accept two arguments. Return `true` to ACK, `false` to NACK.
- [onI2CStop()](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#52-53): Transaction end.
-   [onSPIByte(data)](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/BaseComponent.ts#54-55): Handle full-duplex byte exchange.

### Validation Engine
The `validator` (from [check](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-arduino-uno/validation.ts#101-121) function) provides:
-   `validator.calculateVoltageAtNode(pinId)`: Estimates voltage at a pin.
-   `validator.findSeriesResistance(pinId)`: Traces path to power through resistors.

---

## 5. Master Templates for AI Generation

### A. [index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/index.ts) (The Bridge)
```typescript
import manifest from './manifest.json';
import { MyUI } from './ui';
import { MyLogic } from './logic';
import { validation } from './validation';
// MUST export as default object matching this exact structure:
export default { manifest, UI: MyUI, Logic: MyLogic, validation };
```

### B. [logic.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/wokwi-led/logic.ts) Template
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

## 6. Global Registration Requirement
After generating the 5 files, the agent MUST add this line to [src/components/index.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator-danish/src/components/index.ts):
`export { default as myNewComponent } from './my-new-component';`

---

## 7. UI Controls & Canvas Interaction (ui.tsx)
If the component includes interactive HTML elements (like `<input>`, `<button>`, or sliders) overlaying the SVG, the AI MUST follow these rules to prevent canvas freezing:

### A. The `onInteract` Location
The interaction callback is passed inside the `attrs` object, NOT as a top-level prop.
- **CORRECT**: `attrs.onInteract({ type: 'SET_VAL', value: 10 })`
- **WRONG**: `onInteract({ ... })` 

### B. Punching Through the Canvas Lock
When the simulation runs, the canvas locks components with CSS. To make custom HTML controls clickable during simulation, their wrapper MUST include:
`style={{ pointerEvents: 'auto' }}`

### C. Stopping Drag Propagation
HTML inputs must prevent mouse events from bubbling up to the canvas, otherwise, clicking the input will drag the component. Add these to all inputs:
`onPointerDown={(e) => e.stopPropagation()}`
`onMouseDown={(e) => e.stopPropagation()}`
`onTouchStart={(e) => e.stopPropagation()}`

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

**NOW READY**: Tell the AI agent what component you want, and instruct it to follow the "OpenHW Studio 5-File Component Pattern" defined in this manual.
