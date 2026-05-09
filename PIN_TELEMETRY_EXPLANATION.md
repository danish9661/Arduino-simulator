# Telemetry Event Flow Diagram

## Your Pico+LCD2004 Test: Event Capture Visualization

```
TIMELINE: 0ms ──────────────────────► 8000ms
                                      │
                                      ▼
         ┌──────────────────────────────────┐
         │   BASELINE SNAPSHOT (t=0ms)      │
         └────────┬─────────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │             │             │
    ▼             ▼             ▼
Pico State    LCD State      (no pin transitions yet)
txActive→F    lines→["..."]
rxActive→F    illuminated→T
builtInLed→F  color→"blue"
env→native
builder→{...}
isWired→true
```

**Event Count at Baseline:** 10 ComponentState events

```
         ┌──────────────────────────────────┐
         │   RUNTIME CAPTURE (t=1-8000ms)   │
         └────────┬─────────────────────────┘
                  │
          ┌───────┴───────┐
          │               │
          ▼               ▼
    No GPIO         I2C Activity
    toggles         (LCD comms)
    on Pico         
    (static)        SDA transitions
                    ↕️ ↕️ ↕️ (many)
                    SCL transitions
                    ↕️ ↕️ ↕️ (many)
                    │
                    ▼
              1 PinChange Event
              (aggregated by component)
```

**Event Count at Runtime:** 1 PinChange event

**Total Events:** 10 (baseline) + 1 (runtime) = **11 events ✅**

---

## Component Telemetry Coverage Map

```
┌─────────────────────────────────────────────────────────┐
│            EMULATOR COMPONENT LANDSCAPE                 │
└─────────────────────────────────────────────────────────┘

┌─── BOARDS ──────────────────────────────────────────┐
│                                                     │
│  ✅ Pico          → Exposes: txActive, rxActive    │
│  ❌ Arduino Uno   → Silent (state exists but      │
│  ❌ Arduino Mega  │  not exposed)                 │
│  ❌ ATtiny85      │                               │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─── DISPLAYS ────────────────────────────────────────┐
│                                                     │
│  ✅ LCD2004 I2C   → Exposes: lines[], color       │
│  ✅ SSD1306 OLED  → Exposes: pixelBuffer[]        │
│  ❌ LCD1602 I2C   → Silent (state not exposed)    │
│  ❌ Nokia 5110    → Silent (complex rendering)    │
│  ❌ 7-segment     → Silent (use LED intensity)    │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─── SENSORS ─────────────────────────────────────────┐
│                                                     │
│  ✅ MAX30102      → Exposes: heartRate, SpO2      │
│  ✅ Potentiometer → Exposes: voltage, resistance  │
│  ✅ Joystick      → Exposes: x, y, sw             │
│  ✅ LDR Module    → Exposes: lux, resistance      │
│  ❌ HC-SR04       → Silent (distance not exposed) │
│  ❌ Soil Moisture → Silent (analog only)          │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─── ACTUATORS ───────────────────────────────────────┐
│                                                     │
│  ✅ Servo         → Exposes: pulseWidthUs, angle  │
│  ✅ Buzzer        → Exposes: frequency, volume    │
│  ✅ Neopixel Ring → Exposes: colors[], power      │
│  ✅ MAX7219       → Exposes: displayBuffer[]      │
│  ❌ Motor         → Silent (speed not exposed)    │
│  ❌ Stepper       → Silent (step not exposed)     │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─── INPUT ───────────────────────────────────────────┐
│                                                     │
│  ❌ Button        → Pin-level only (state silent) │
│  ❌ Rotary Enc    → Pin-level only                │
│  ❌ Membrane KP   → Pin-level only                │
│                                                     │
└─────────────────────────────────────────────────────┘

┌─── STORAGE/DRIVERS ─────────────────────────────────┐
│                                                     │
│  ❌ SD Card       → I2C/SPI pin activity only     │
│  ❌ PCA9685       → I2C pin activity only         │
│  ❌ PCA9865       → I2C pin activity only         │
│  ❌ CD74HC4067    → Digital pin activity only     │
│                                                     │
└─────────────────────────────────────────────────────┘

Legend:
  ✅ = Exposes customTelemetry (functional level)
  ❌ = Silent (pin/electrical level only)
  Pin-level = Can infer from GPIO transitions
```

---

## Why Only LCD2004 Pins Showed as PinChange Events

```
ELECTRICAL LAYER (Pin Transitions):

Pico GPIO 0 (SDA):
  __|‾|_|‾|_|‾|_|‾|_|‾|_|‾|_|‾|_|‾ → I2C clock/data
                                      
Pico GPIO 1 (SCL):
  __|‾‾‾|___|‾‾‾|___|‾‾‾|___|‾‾‾ → Continuously transitioning
     ↑↑↑ Captured!                    During I2C comms
     └─ PinChange events emitted

LED (GP25):
  __|‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ → Never changes
     ↑ (set once at startup)
     └─ No PinChange event (static)

Buzzer (GPIO X):
  __|‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ → Never driven
     ↑ (never toggled)
     └─ No PinChange event


RESULT:
  I2C Pins    → Many transitions → 1 aggregated PinChange event
  GPIO        → No transitions   → 0 PinChange events
  Buzzer      → No transitions   → 0 PinChange events
  ──────────────────────────────────────────────────
  TOTAL PinChange: 1 (LCD2004 I2C pins)
```

---

## Pin Telemetry: Is This Correct Behavior?

**Question:** Why don't I see PinChange events for Pico GPIO pins or other components?

**Answer:** 

| Scenario | What Happened | Is Correct? | Why |
|----------|---|---|---|
| I2C SDA/SCL toggled constantly | ✅ Captured 1 PinChange | YES | Protocol requires transitions |
| LED pin stayed HIGH | ❌ No PinChange | YES | No state change = no event |
| Buzzer pin never toggled | ❌ No PinChange | YES | Code didn't drive it |
| Other GPIO idle | ❌ No PinChange | YES | Idle pins don't transition |

**Is this the correct behavior for grading?** ✅ **YES**

Reason: Behavioral grading measures **observable changes**. If a pin never transitions, there's no behavior to validate. You can infer:
- "Buzzer never fired" (correctly detected as no events)
- "LED stayed on" (functionally captured in Pico state)
- "I2C worked" (visible in PinChange events)

---

## Why Different Components Expose Different Telemetry

```
DESIGN PRINCIPLE:
  
  onCustomTelemetry Hook
        │
        └─→ Available IF component library exposes it
            ├─ LCD2004 I2C: Library has display buffer → ✅ Exposed
            ├─ LCD1602 I2C: Library doesn't expose → ❌ Silent
            ├─ Arduino: SDK too generic → ❌ Silent
            └─ MAX30102:  Sensor lib has PPG output → ✅ Exposed

  Fallback: Pin-level observation
        │
        └─→ ALWAYS available (electrical level)
            └─ Transitions visible to grading engine
```

**Cost/Benefit:**
- ✅ Only exposing telemetry **reduces overhead** (don't expose everything)
- ✅ Grading still works via **pin inference** when telemetry unavailable
- ✅ Best-case: component telemetry + pin transitions (LCD2004)
- ⚠️ Worst-case: pin transitions only (static displays, motors)

---

## Recommendation: Should We Expand Pin Telemetry Capture?

### Current Behavior
```
Captures: Transitions only
Cost: Minimal (11 events for full 8s simulation)
Coverage: Functional (PCom) + Electrical (I2C) ✅
```

### Option 1: Capture All GPIO Reads (Not Just Transitions)
```
Captures: Every GPIO read operation
Cost: 100-1000x overhead (could reach 10k+ events)
Benefit: Detect code reading but not acting on values
Use case: Validating input sensing (button debounce logic)
```

### Option 2: Lower AI Entropy Threshold
```
Affects: AI semantic traces (not grading score)
Current: Filters out "static" values (no transitions)
Change: Allow static values to generate tokens
Result: "silent" → "LCD shows 'Welcome'" (narrative)
```

### Recommendation
- **Keep pin telemetry as-is** (transitions only) ✅
- **Grading works correctly** (score 100 with 11 events) ✅
- **Option 2 only if needed** for AI narrative traces

---

## Summary for Your Test

```
Pico + LCD2004 Circuit:
  
  Events Captured:
    10 × ComponentState (initial board + LCD state)
    1  × PinChange     (I2C pin activity)
    ──────────────────
    11 TOTAL ✅

  Grading Score: 100 ✅
  Behavior Match: Perfect ✅
  AI Traces: "silent" (correct—no state transitions) ✅
  
  Explanation:
    - Pico state captured (board telemetry enabled)
    - LCD state captured (display telemetry enabled)
    - I2C pins captured (protocol-level transitions)
    - No other pins toggled (LED, buzzer unused)
    - AI found zero transitions (circuit state static)
```

