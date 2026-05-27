# STM32 + Renode — Implementation Plan

## How the Existing ESP32 Pipeline Works (Reference)

```
User code → POST /api/compile {target:'esp32'}
→ arduino-cli → .bin
→ esptool merges flash → merged-flash.bin
→ QemuRunner (qemu-system-xtensa)
  UART TCP bridge parses >GPIO:pin:val< frames
→ wsManager.sendToSession({type:'GPIO_SYNC', pin, value})
→ Frontend BackendProxyRunner.syncGpio()
  Updates mock component instances → SVG canvas at 60fps
```

**Key existing files:**

| File | Role |
|---|---|
| `src/esp32/utils/SimulatorBridge.h` | Injected C header — intercepts `digitalWrite` → emits `>GPIO:pin:val<` over UART |
| `src/esp32/utils/SimulatorWire.h/cpp` | Intercepts I2C → emits `>I2C:addr:hex<` |
| `src/esp32/utils/SimulatorSPI.h/cpp` | Intercepts SPI → emits `>SPI:hex<` |
| `src/esp32/controller/compileController.js` | Compiles, injects shims, launches QemuRunner |
| `src/esp32/utils/qemuRunner.js` | Spawns QEMU, parses UART, routes to WS |
| `src/esp32/utils/websocketManager.js` | Per-session WS management |
| `src/esp32/index.js` | Module barrel |
| `src/routes/compile.js` | Registers `/esp32/stop` etc. |
| `src/worker/execute.ts` | `createRunnerForBoard()` — already routes `stm32` to `BackendProxyRunner` |
| `src/worker/runners/backend-proxy-runner.ts` | Already handles `stm32` regex on lines 70 & 87 |
| `openhw-studio-emulator/.../ESP32/` | Board component: manifest + logic stub + SVG |

---

## STM32 Will Mirror This Exactly

```
User code → POST /api/compile {target:'stm32'}
→ [NEW] stm32/controller/compileController.js
→ arduino-cli --fqbn STM32:stm32:GenF1 → .elf
→ [NEW] RenodeRunner spawns Renode
  Renode UART1 → TCP socket → Node.js parses >GPIO:PA5:1<
→ wsManager.sendToSession({type:'GPIO_SYNC', pin:'PA5', value:1})
→ BackendProxyRunner.syncGpio('PA5', true) ← NO CHANGES NEEDED
  → LED lights up on canvas ✅
```

---

## Files To Create / Modify

### BACKEND — New `src/stm32/` Module

#### [NEW] `src/stm32/utils/STM32SimulatorBridge.h`
Arduino C header injected at compile time. Intercepts GPIO calls and emits frames over `Serial1` (UART1).

Same protocol as ESP32 bridge (so `BackendProxyRunner` needs zero changes):
- `>GPIO:<portpin>:<val><` e.g. `>GPIO:PA5:1<`
- `>SIM:READY<` when `setup()` completes
- `>SIM:BEAT<` heartbeat every 5s
- `>I2C:<addr>:<hex><` on Wire writes
- `>SPI:<hex><` on SPI transfers

Incoming from Node.js:
- `<GPIO:pin:val>\n` — virtual pin injection
- `<ADC:pin:val>\n` — analog injection

Key differences from ESP32 bridge:
- No FreeRTOS — STM32 Arduino uses a bare superloop
- Uses `Serial1` (USART1 = PA9/PA10 on Blue Pill)
- Pin names are STM32 port+number (`PA0`, `PC13`, etc.)
- No watchdog disabling needed
- Arduino pin number → STM32 port name lookup table needed

---

#### [NEW] `src/stm32/utils/STM32SimulatorWire.h` + `.cpp`
Overrides `TwoWire` — same as `SimulatorWire.h/cpp`.

#### [NEW] `src/stm32/utils/STM32SimulatorSPI.h` + `.cpp`
Overrides `SPIClass` — same as `SimulatorSPI.h/cpp`.

---

#### [NEW] `src/stm32/utils/renodeRunner.js`
Core of the STM32 backend. Mirrors `qemuRunner.js`.

```javascript
// Generates .resc script dynamically:
const resc = `
mach create "stm32"
machine LoadPlatformDescription @platforms/cpus/stm32f103.repl
sysbus LoadELF @${elfPath}
sysbus.uart1 CreateTcpServer ${tcpPort}
start
`;

// Spawns Renode:
spawn('renode', ['--plain', '--disable-xwt', '-e', resc]);

// Node.js connects to the Renode TCP UART server:
net.connect(tcpPort, '127.0.0.1', socket => {
    socket.on('data', chunk => this._handleSerialData(chunk));
});

// _handleSerialData() — IDENTICAL parsing logic to qemuRunner.js:
// >GPIO:PA5:1<  → wsManager.sendToSession({type:'GPIO_SYNC', pin:'PA5', value:1})
// >SIM:READY<   → this.isReady = true
// >I2C:3c:ab<   → wsManager.sendToSession({type:'I2C_TRANSACTION', ...})

// setVirtualPin(pin, value):
socket.write(`<GPIO:${pin}:${value}>\n`);
```

**Key difference from qemuRunner:** Renode's `CreateTcpServer` makes Renode the TCP server; Node.js is the client (reverse of ESP32 setup where Node.js is the server).

---

#### [NEW] `src/stm32/utils/websocketManager.js`
Re-export the existing ESP32 `websocketManager.js` (sessions are keyed by `buildId`, board-type agnostic).

---

#### [NEW] `src/stm32/controller/compileController.js`
Mirrors `src/esp32/controller/compileController.js` with these key differences:

```javascript
const STM32_FQBN = process.env.STM32_FQBN
    || 'STM32:stm32:GenF1:pnum=BLUEPILL_F103C8';

// No esptool step — Renode loads .elf directly
const compileArgs = ['compile', '--fqbn', STM32_FQBN,
    '--output-dir', buildDir, sketchFile];

// Find .elf artifact (not .bin/.hex)
const elfFile = fs.readdirSync(buildDir).find(f => f.endsWith('.elf'));

// Launch RenodeRunner
const runner = new RenodeRunner(buildId, elfPath, buildDir);
_activeRunners.set(buildId, runner);
runner.start();

// Shim headers:
const SHIM_HEADERS = [
    { src: 'STM32SimulatorBridge.h', dst: 'SimulatorBridge.h' },
    { src: 'STM32SimulatorWire.h',   dst: 'Wire.h' },
    { src: 'STM32SimulatorWire.cpp', dst: 'Wire.cpp' },
    { src: 'STM32SimulatorSPI.h',    dst: 'SPI.h' },
    { src: 'STM32SimulatorSPI.cpp',  dst: 'SPI.cpp' },
];
```

WS message handlers (identical to ESP32):
`REGISTER_SESSION`, `SET_GPIO`, `SET_ADC`, `SERIAL_INPUT`, `I2C_RESP_SET`

---

#### [NEW] `src/stm32/index.js`
```javascript
export function initSTM32Module(httpServer) { wsManager.init(httpServer); }
export const handleSTM32Compile = compileArduinoCode;
export const handleSTM32Stop    = stopSession;
```

---

### BACKEND — Modify Existing Files

#### [MODIFY] `src/routes/compile.js`
```javascript
import { handleSTM32Stop } from '../stm32/index.js';
router.post('/stm32/stop/:buildId', handleSTM32Stop);
```

#### [MODIFY] `src/controllers/compileController.js`
```javascript
import { handleSTM32Compile } from '../stm32/index.js';
// Inside compileArduinoCode:
if (target === 'stm32') return handleSTM32Compile(req, res);
```

#### [MODIFY] `src/server.js`
```javascript
import { initSTM32Module } from './stm32/index.js';
initSTM32Module(httpServer);
```

---

### EMULATOR — New STM32 Board Component

#### [NEW] `openhw-studio-emulator/src/components/openhw-stm32-bluepill/manifest.json`
```json
{
  "type": "openhw-stm32-bluepill",
  "label": "STM32 Blue Pill",
  "description": "STM32F103C8T6 Cortex-M3 @ 72MHz. 37 GPIO, UART/SPI/I2C, 64KB flash.",
  "group": "Boards",
  "board": true,
  "w": 120, "h": 340,
  "pins": [
    { "id": "PA0",  "description": "A0",   "x": 7.5,  "y": 37.5 },
    { "id": "PA1",  "description": "A1",   "x": 7.5,  "y": 52.5 },
    { "id": "PA2",  "description": "TX2",  "x": 7.5,  "y": 67.5 },
    { "id": "PA3",  "description": "RX2",  "x": 7.5,  "y": 82.5 },
    { "id": "PA4",  "description": "NSS",  "x": 7.5,  "y": 97.5 },
    { "id": "PA5",  "description": "SCK",  "x": 7.5,  "y": 112.5 },
    { "id": "PA6",  "description": "MISO", "x": 7.5,  "y": 127.5 },
    { "id": "PA7",  "description": "MOSI", "x": 7.5,  "y": 142.5 },
    { "id": "PB0",  "description": "B0",   "x": 7.5,  "y": 157.5 },
    { "id": "PB1",  "description": "B1",   "x": 7.5,  "y": 172.5 },
    { "id": "PB10", "description": "TX3",  "x": 7.5,  "y": 187.5 },
    { "id": "PB11", "description": "RX3",  "x": 7.5,  "y": 202.5 },
    { "id": "PC13", "description": "LED",  "x": 7.5,  "y": 217.5 },
    { "id": "GND",  "description": "GND",  "x": 7.5,  "y": 232.5, "type": "power" },
    { "id": "3V3",  "description": "3.3V", "x": 7.5,  "y": 247.5, "type": "power" },
    { "id": "PA9",  "description": "TX1",  "x": 120.0,"y": 112.5 },
    { "id": "PA10", "description": "RX1",  "x": 120.0,"y": 127.5 },
    { "id": "PB6",  "description": "SCL",  "x": 120.0,"y": 217.5 },
    { "id": "PB7",  "description": "SDA",  "x": 120.0,"y": 232.5 }
  ]
}
```

#### [NEW] `logic.ts` — same stub as ESP32
```typescript
import { BaseComponent } from '../BaseComponent';
export class STM32BluePillLogic extends BaseComponent {
    constructor(id: string, manifest: any) { super(id, manifest); }
    update() { /* Runs remotely in Renode */ }
}
```

#### [NEW] `index.ts`
```typescript
export { STM32BluePillLogic as default } from './logic';
```

#### [NEW] `ui.tsx` — SVG of the Blue Pill board
Use ESP32 `ui.tsx` as template. Replace with Blue Pill shape and PA/PB pin labels.

#### [MODIFY] `openhw-studio-emulator/src/components/index.ts`
Register the new logic class.

---

### FRONTEND — No Changes Needed

`execute.ts` line 14 already routes `stm32` to `BackendProxyRunner`:
```typescript
if (/(esp32|stm32)/i.test(boardType)) return new BackendProxyRunner(...);
```

`backend-proxy-runner.ts` lines 70 & 87 already detect `stm32` boards. ✅

---

## Implementation Order

- `[ ]` Step 1 — `STM32SimulatorBridge.h` (defines protocol — most critical)
- `[ ]` Step 2 — `STM32SimulatorWire.h/cpp` + `STM32SimulatorSPI.h/cpp`
- `[ ]` Step 3 — `renodeRunner.js`
- `[ ]` Step 4 — `stm32/controller/compileController.js`
- `[ ]` Step 5 — `stm32/index.js` + `stm32/utils/websocketManager.js`
- `[ ]` Step 6 — Modify `routes/compile.js`, `server.js`, `controllers/compileController.js`
- `[ ]` Step 7 — Emulator component `openhw-stm32-bluepill/`
- `[ ]` Step 8 — Register component in emulator `index.ts`
- `[ ]` Step 9 — E2E test: blink sketch on Blue Pill

---

## Environment Variables

```bash
STM32_FQBN=STM32:stm32:GenF1:pnum=BLUEPILL_F103C8
RENODE_PATH=renode
STM32_MAX_SESSIONS=5
STM32_SESSION_TIMEOUT_MS=300000
```

## Prerequisites

```bash
arduino-cli core install STM32:stm32
# Install Renode from https://renode.io
renode --version
```

---

## Open Questions

> [!IMPORTANT]
> **Which board variant first?** Blue Pill (F103C8) recommended. Add Nucleo-F411RE separately?

> [!IMPORTANT]
> **Arduino → STM32 port name mapping:** The `STM32SimulatorBridge.h` needs a compile-time lookup table converting Arduino numeric pin → STM32 port name. This depends on the FQBN/variant chosen.

> [!NOTE]
> **Renode TCP direction:** Renode is the TCP server; Node.js connects as client. Build a retry/reconnect loop in `renodeRunner.js` since Renode takes ~1-2s to start.
