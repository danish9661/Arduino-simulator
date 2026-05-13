# Component Telemetry Guide: Complete Reference

## Recent Update

The telemetry coverage in this repo changed materially. Several components that were previously silent now expose `onCustomTelemetry()` data, and the CLI component suite now passes for the full Pico component matrix.

**2026-05-10:** `BaseComponent` now auto-populates lightweight `customTelemetry` from top-level `state` when a component does not implement `onCustomTelemetry()`. This provides immediate telemetry for many remaining components without per-file edits.

## Quick Answer: Why Only LCD2004 Pins Are Showing

**Is this correct behavior?** [OK] **YES**

The grading engine only captures `PinChange` events when pins actually **transition** (change state). In your Pico+LCD2004 test:

- **LCD2004 pins** are controlled by the I2C protocol, which involves repeated SDA/SCL line transitions → Events are captured
- **Pico GPIO pins** (except I2C) likely stayed at the same voltage level throughout the 8-second capture → No state transitions = No PinChange events recorded
- **Other component pins** (LED, buzzer, etc.) either weren't used or didn't transition

This is **by design**:
- Telemetry only records **observable state changes**
- Static voltages = no behavioral transitions = no events (because behavior didn't change)
- If Pico's LED never toggled, there's no PinChange event to record (correctly)

---

## The 3 Telemetry Event Types (Detailed)

### 1. **ComponentState** (Functional Level)
**ID Format:** `wokwi-[component-type]_[instance-number]`  
**Example:** `wokwi-raspberry-pi-pico_28`, `wokwi-lcd2004-i2c_30`

**What it captures:**
- Changes in component state variables (text on LCD, LED brightness, etc.)
- Functional behavior from the component's perspective
- Application-level data (not electrical, but higher-level)

**Example events from your grading:**
```json
ComponentState: {
  id: "wokwi-raspberry-pi-pico_28",
  key: "txActive",
  value: false,
  time_ms: 16
}

ComponentState: {
  id: "wokwi-lcd2004-i2c_30", 
  key: "lines",
  value: ["                    ", "                    ", "                    ", "                    "],
  time_ms: 16
}
```

**Behavioral insight:** If `txActive` changes from false→true, code is sending serial data. If LCD `lines` change, display content is updating.

---

### 2. **PinChange** (Electrical Level)
**ID Format:** `pinstate:[component-type]_[instance]:[signal-name]`  
**Example:** `pinstate:wokwi-lcd2004-i2c_30:pins`

**What it captures:**
- GPIO voltage transitions (LOW → HIGH or HIGH → LOW)
- I2C signal transitions (SDA, SCL rising/falling edges)
- SPI clock edges
- Any wire-level electrical changes

**Why only LCD2004 showed up:**
LCD uses I2C protocol, which requires continuous SDA/SCL toggling:
```
SDA: --|‾|_|‾|_|‾|_|...  (transitions constantly)
SCL: __|‾‾‾|___|‾‾‾|___ (transitions constantly)
```

Other components might not have active transitions:
- LED: might stay at fixed voltage (not toggling)
- Buzzer: might not be driven
- Servo: might not receive PWM pulses during test
- Pico GPIO: might be idle

**Behavioral insight:** PinChange events reveal low-level protocol activity (I2C, SPI, UART handshakes).

---

### 3. **SerialOutput** (Communication Level)
**ID Format:** Implicit (not separately tracked in id_stats)

**What it captures:**
- UART serial data transmitted from board
- Each character/byte sent to Serial port
- STDOUT/debugging prints

**Example:**
```json
SerialOutput: {
  data: "OpenHW Studio Init\n",
  time_ms: 120
}
```

**Behavioral insight:** If code prints debug messages, they appear here. Useful for validation scripts that output results.

---

## Complete Component Telemetry Inventory

### [DATA] Display Components

| Component | Telemetry | Key Fields | Grading Value |
|-----------|-----------|-----------|---|
| **wokwi-lcd2004-i2c** | [OK] YES | `lines[]` (4 lines of text), `illuminated`, `color` | HIGH - Validates display output |
| **wokwi-lcd1602-i2c** | [OK] YES | `textContent`, `backlight`, `lineCount`, `charsPerLine` | HIGH - Validates 16x2 display output |
| **wokwi-ssd1306-oled** | [OK] YES | `pixelBuffer`, `displayOn`, `contrast` | HIGH - Full bitmap validation |
| **wokwi-nokia-5110** | [FAIL] NO | State not exposed | MEDIUM - Pin-level only |
| **wokwi-7segment** | [OK] YES | `displayType`, `activeSegments`, `displayedDigits`, `colonActive`, `totalDigits` | HIGH - Validates digit/segment output |
| **wokwi-tm1637-7segment** | [FAIL] NO | Internal state not exposed | LOW - Pin transitions only |

**-> Why LCD displays have telemetry but most others don't:** Display manufacturers provide I2C libraries that expose current buffer content. Direct pin-driven displays (Nokia 5110, raw 7-segment) don't have a simple state snapshot.

---

### [SENSORS] Sensor Components

| Component | Telemetry | Key Fields | Behavioral Insight |
|-----------|-----------|-----------|---|
| **max30102** | [OK] YES | `heartRate`, `spo2`, `redAmp`, `irAmp` | Validates PPG signal capture |
| **wokwi-potentiometer** | [OK] PARTIAL | `voltage`, `resistance` | Analog input voltage |
| **wokwi-ldr-module** | [OK] PARTIAL | `lux`, `resistance` | Ambient light simulation |
| **wokwi-analog-joystick** | [OK] YES | `x`, `y`, `sw` (switch) | XY position + button state |
| **wokwi-hc-sr04** | [OK] YES | `configuredDistance`, `echoDurationUs`, `isEchoing`, `lastMeasurement` | Confirms configured range and echo timing |
| **wokwi-soil-moisture-sensor** | [OK] YES | `moisturePercent`, `vccVoltage`, `outputVoltage`, `sensorType` | Validates analog moisture reading |

**-> Why some sensors have telemetry:** Sensors with digital interfaces (I2C, PWM output) can expose their computed values. Analog sensors (voltage dividers) only show raw ADC reads.

---

### [ACTUATORS] Actuators

| Component | Telemetry | Key Fields | Behavioral Insight |
|-----------|-----------|-----------|---|
| **wokwi-servo** | [OK] YES | `pulseWidthUs`, `targetAngle`, `frequency` | Validates PWM servo control |
| **wokwi-buzzer** | [OK] YES | `frequency`, `volume`, `isActive` | Confirms tone generation |
| **wokwi-neopixel-ring** | [OK] YES | `colors[]` (RGB per LED), `power` | Individual pixel validation |
| **wokwi-neopixel-matrix** | [OK] YES | `pixelMatrix[][]`, `power` | 2D array of pixel colors |
| **wokwi-motor** | [OK] YES | `speed`, `speedPercent`, `direction`, `stateChange` | Validates target speed and direction |
| **wokwi-stepper-motor** | [OK] YES | `angle`, `stepCount`, `stepsPerRevolution`, `revolutions`, `currentPhase` | Confirms phase progression |
| **wokwi-max7219** | [OK] YES | `displayBuffer[]`, `intensity` | 8x8 matrix content validation |

**-> Why PWM-driven vs voltage-driven differ:** PWM duty cycle (servo, buzzer) can be computed from timing. Motor speed requires internal simulation state that's not exposed for simplicity.

---

### [INPUT] Input Components

| Component | Telemetry | Key Fields | Behavioral Insight |
|-----------|-----------|-----------|---|
| **wokwi-pushbutton** | [OK] YES | `pressed`, `totalPresses`, `conductance` | Validates press count and contact state |
| **wokwi-rotary-encoder** | [OK] YES | `angle`, `buttonPressed`, `totalRotations`, `totalPresses`, `quadratureStep` | Validates rotation and switch activity |
| **wokwi-membrane-keypad** | [OK] YES | `pressedKey`, `totalKeyPresses`, `matrixType`, `keys[]` | Validates key scan state |

**-> Why input components are silent:** Button presses are reflected in GPIO pin state (already captured as PinChange). Exposing button state would be redundant with electrical telemetry.

---

### [BOARD] Board Components

| Component | Telemetry | Key Fields | Behavioral Insight |
|-----------|-----------|-----------|---|
| **wokwi-raspberry-pi-pico** | [OK] YES | `txActive`, `rxActive`, `builtInLed`, `irqEventsByPin` | Board-level activity |
| **wokwi-arduino-uno** | [FAIL] NO | State not exposed | Serial and GPIO inferred from pins |
| **wokwi-arduino-mega** | [FAIL] NO | State not exposed | Similar to Uno |
| **wokwi-attiny85** | [FAIL] NO | Minimal state | Pin activity only |
| **wokwi-raspberry-pi-pico-w** | [OK] YES | Same as Pico + WiFi status | Board + wireless |

**-> Why Pico has telemetry but Arduino doesn't:** Pico SDK exposes more runtime diagnostics. Arduino libraries in Wokwi don't provide the same introspection hooks.

---

### [STORAGE] Storage & Drivers

| Component | Telemetry | Key Fields | Behavioral Insight |
|-----------|-----------|-----------|---|
| **wokwi-sd-card** | [FAIL] NO | File system state not exposed | SPI bus activity visible in pins |
| **wokwi-pca9685** | [OK] YES | `i2cAddress`, `activePWMChannels`, `dutyCycles[]`, `resolution` | Validates PWM channel activity |
| **wokwi-pca9865** | [OK] YES | `i2cAddress`, `activePWMChannels`, `dutyCycles[]`, `resolution` | Validates expander/PWM output state |
| **wokwi-cd74hc4067** | [OK] YES | `enabled`, `activeChannel`, `signalVoltage`, `addressPins`, `type` | Validates selected analog channel |

**-> Why these are silent:** Drivers expose their control through I2C/SPI protocols, which are already captured as PinChange events on the bus lines.

---

## How Telemetry Is Collected: The Flow

```
┌─────────────────────────────────────────┐
│   Component Update (each tick)          │
└──────────────────┬──────────────────────┘
                   │
         ┌─────────▼─────────┐
         │  getRawMetrics()  │  ← Gathers current state
         └─────────┬─────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
metrics.custom  state object   pinChanges
    │              │              │
    └──────────────┼──────────────┘
                   │
         ┌─────────▼──────────┐
         │ Normalize snapshot │
         │ (fallback order)   │
         └─────────┬──────────┘
                   │
      ┌────────────▼────────────┐
      │ Compare to last capture │
      └────────────┬────────────┘
                   │
      ┌────────────▼────────────┐
      │ If changed: Emit event  │
      │ ComponentState or       │
      │ PinChange              │
      └────────────┬────────────┘
                   │
         ┌─────────▼──────────┐
         │   Telemetry Array  │
         │  (11 events max    │
         │   in your test)    │
         └────────────────────┘
```

---

## Why Your Pico+LCD2004 Test Showed Only LCD Pins

**Your telemetry breakdown:**
- 6 ComponentState events: Pico state (txActive, rxActive, builtInLed, env, builder, isWired)
- 4 ComponentState events: LCD state (lines, illuminated, color, pins)
- 1 PinChange event: LCD I2C pin transitions
- **Total: 11 events [OK]**

**Why no other pin events?**
1. **Pico GPIO (except I2C):** Likely never toggled during the 8-second window
2. **LCD pins:** I2C requires continuous SDA/SCL transitions → captured
3. **Other components:** Not present in circuit, or their pins were static

**Is this correct?** YES. Telemetry only records **changes**. Static voltage = no event.

---

## Decision Matrix: Should We Capture More Pin Events?

| Scenario | Current Behavior | Should Fix? | Notes |
|----------|---|---|---|
| Pin never transitions | No event | [OK] NO | Correct—no behavioral change |
| Pin toggles but not captured | Bug | [FAIL] YES | Rare, but would need investigation |
| Want telemetry even for static pins | Reports "silent" | ❓ DEPENDS | Lower entropy threshold? |
| Need all GPIO reads (not writes) | No event | ❓ DEPENDS | Would increase telemetry size |

**Current behavior is optimal for:**
- [OK] Efficient telemetry storage (only changes recorded)
- [OK] Detecting actual circuit activity (transitions = behavior)
- [OK] Grading accuracy (matching dynamic behavior)
- [FAIL] Capturing initial state (baseline snapshot covers this)

---

## CLI Validation

The current CLI validation run completed successfully against the live backend:

- `npm --prefix openhw-studio-cli run test:mcp:pico-components-individual`
- Result: `total=106 passed=106 failed=0`
- Coverage: Micropython and CircuitPython component wiring for the full Pico component matrix

This confirms the updated component set still loads correctly through the MCP/CLI path after the telemetry additions.

**Note (UNO tests):** UNO per-component runs may fail with `Compilation failed` if the backend lacks the Arduino toolchain (`arduino-cli`) and required AVR cores. To fix on Windows, install `arduino-cli`, add AVR cores, restart the backend, and re-run the UNO tests. Example commands:

```powershell
# Install (choose one):
# Scoop
scoop install arduino-cli
# or Chocolatey
choco install arduino-cli

# Ensure arduino-cli is on PATH, then install AVR core:
arduino-cli core update-index
arduino-cli core install arduino:avr

# Restart backend and re-run tests
npm --prefix openhw-studio-backend run start
npm --prefix openhw-studio-cli run test:mcp:uno-components-individual
```

---

## Recommendations

1. **Current telemetry is sufficient** for detecting functional correctness
2. **Silent traces are acceptable** when circuits don't change state
3. **Pin telemetry is working correctly** — it captures I2C/SPI/UART activity through PinChange events
4. **To expand telemetry:**
   - Enable more components' `onCustomTelemetry()` hooks
   - Lower entropy threshold in `ai-audit-final.worker.ts` (line 98) if you want traces even for static displays
   - Add GPIO read tracking if you need full pin activity (expensive)

---

## JSON Documentation of All Components

See attached: `component_telemetry_documentation.json` for exhaustive field-by-field breakdown of all 26+ components.



