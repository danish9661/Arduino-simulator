# Telemetry UI in OpenHW Studio Frontend - Visual Guide

## 🎨 Main Simulation Interface with Telemetry

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    OpenHW Studio - Circuit Simulator                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [Arduino Code]  [▶ Run] [⏸ Pause] [⏹ Stop] [F1] Quick Actions        │
│                                                                         │
│  ┌──────────────────────────┐    ┌─────────────────────────────────┐   │
│  │   CIRCUIT CANVAS         │    │  RIGHT PANEL - TELEMETRY VIEW   │   │
│  │                          │    ├─────────────────────────────────┤   │
│  │  ┌──────┐   ┌────┐      │    │ 📊 LIVE TELEMETRY              │   │
│  │  │Pico  ├───┤LCD │      │    │ ─────────────────────────────  │   │
│  │  │      │   │2004│      │    │                                 │   │
│  │  └──────┘   └─┬──┘      │    │ Selected Component: LCD2004     │   │
│  │              │          │    │ ID: wokwi-lcd2004-i2c_30       │   │
│  │         ┌────┴────┐     │    │                                 │   │
│  │         │ Buzzer  │     │    │ 🔄 Custom Telemetry:           │   │
│  │         └─────────┘     │    │ ┌─────────────────────────────┐ │   │
│  │                          │    │ │ lines:                      │ │   │
│  │                          │    │ │ ["Hello    ", "OpenHW", ... │ │   │
│  │                          │    │ │ illuminated: true           │ │   │
│  │                          │    │ │ backlight: 255              │ │   │
│  │                          │    │ │ cursorX: 5                  │ │   │
│  │                          │    │ │ cursorY: 0                  │ │   │
│  │                          │    │ └─────────────────────────────┘ │   │
│  │                          │    │                                 │   │
│  │                          │    │ 🔌 Pin States:                 │   │
│  │                          │    │ ┌─────────────────────────────┐ │   │
│  │                          │    │ │ SDA: HIGH   (1)             │ │   │
│  │                          │    │ │ SCL: HIGH   (1)             │ │   │
│  │                          │    │ │ GND: LOW    (0)             │ │   │
│  │                          │    │ │ VCC: HIGH   (1)             │ │   │
│  │                          │    │ └─────────────────────────────┘ │   │
│  │                          │    │                                 │   │
│  │                          │    │ 📈 Event History:              │   │
│  │                          │    │ [t=145ms] ComponentState:LCD   │   │
│  │                          │    │           lines updated        │   │
│  │                          │    │ [t=143ms] PinChange:SDA        │   │
│  │                          │    │ [t=140ms] PinChange:SCL        │   │
│  │                          │    │ [t=138ms] I2CTraffic:          │   │
│  │                          │    │           0x48 0x01 0x20 ...   │   │
│  │                          │    │                                 │   │
│  │                          │    │ ⏱️  Simulation Speed: 1.0x      │   │
│  │                          │    │ ⏱️  Simulation Time: 5.2 sec    │   │
│  │                          │    │ ⏱️  Frame Skip: 0%              │   │
│  │                          │    │                                 │   │
│  │                          │    │ [📋 Export] [🔄 Refresh]       │   │
│  └──────────────────────────┘    └─────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🎛️ Telemetry Selection Modal (F1 Key)

```
┌─────────────────────────────────────────────────────────┐
│          SELECT TELEMETRY COMPONENTS                    │
│                                     [✕] Close           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  This controls which data is collected during          │
│  simulation. Disabling unused metrics improves        │
│  performance.                                           │
│                                                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  🔘 MICROCONTROLLER BOARD DEEP SILICON                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                         │
│  ☑️  Deep Silicon Registers                            │
│      (PC, SP, SREG, CPU cycles)                        │
│      Overhead: ~2% │ Data rate: 50 KB/s                │
│                                                         │
│  ☑️  Deep Silicon SRAM                                 │
│      (Full 2048-byte memory snapshots)                 │
│      Overhead: ~8% │ Data rate: 600 KB/s               │
│      ⚠️  BANDWIDTH INTENSIVE - Disable if not needed   │
│                                                         │
│  ☑️  Deep Silicon Timers                               │
│      (TCNT0, TCNT1, TCNT2 / RP2040 64-bit)            │
│      Overhead: ~1% │ Data rate: 10 KB/s                │
│                                                         │
│  ☑️  Deep Silicon Power Domains                        │
│      (WDT status, sleep modes, voltage domains)        │
│      Overhead: ~1% │ Data rate: 5 KB/s                 │
│                                                         │
│  ☑️  Deep Silicon Interrupts                           │
│      (NVIC pending IRQs, global enable)                │
│      Overhead: ~0.5% │ Data rate: 3 KB/s               │
│                                                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  🔌 COMPONENT-LEVEL CUSTOM METRICS                     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                         │
│  Individual Components (Select from dropdown):         │
│                                                         │
│  ☑️  wokwi-lcd2004-i2c_30                              │
│      ✓ lines (display content)                         │
│      ✓ illuminated (backlight on/off)                  │
│                                                         │
│  ☑️  wokwi-servo_25                                    │
│      ✓ angle (current position)                        │
│      ✓ pulseWidthMs (PWM timing)                       │
│                                                         │
│  ☑️  wokwi-buzzer_18                                   │
│      ✓ frequency (Hz)                                  │
│      ✓ volume (dB)                                     │
│                                                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  📊 COLLECTION MODE                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                         │
│  ◉ Standard (visual state only)      [50 KB/s]         │
│  ○ Deep (full diagnostics)           [300 KB/s]        │
│  ○ Delta (changes only)              [50 KB/s]         │
│                                                         │
│  [Cancel]                         [Apply Settings]     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 📊 Telemetry Event Timeline View

```
TIME (ms)   TYPE             COMPONENT            EVENT DATA
─────────────────────────────────────────────────────────────────────────
0.0ms       ✨ Baseline      (All components)    Initial state snapshot
            ComponentState   pico_28             txActive=false
            ComponentState   pico_28             rxActive=false
            ComponentState   lcd_30              lines=["    ", "    ", ...]
            ComponentState   lcd_30              illuminated=true

85.2ms      📍 PinChange     lcd_30:pins         SDA: LOW→HIGH transition
                             (I2C Start Condition)

86.1ms      📍 PinChange     lcd_30:pins         SCL: LOW→HIGH transition

87.5ms      📡 ProtocolTraffic  lcd_30:i2cTraffic  [0x48, 0x01, 0x20, 0x00]
                                                  (I2C Address + Register)

150.3ms     ✨ Functional    lcd_30              lines[0] = "Hello"
            Update          (display refreshed)

152.8ms     📊 Anomaly       lcd_30              ⚠️ Excessive I2C retries
                                                 (5 retries in 2ms window)

1250.5ms    💾 SerialOutput  uart_tx             "Temperature: 23.5°C\n"

2500.0ms    📊 Report        (all)               Scheduled telemetry snapshot

5000.0ms    ✅ Complete      (simulation)        Telemetry capture ended

Legend:
✨ = Component state change
📍 = Pin-level electrical transition
📡 = Communication protocol data
💾 = Serial/UART output
📊 = Diagnostic metric or anomaly
✅ = Simulation event
```

---

## 🔍 Grading Page Telemetry Comparison

```
┌────────────────────────────────────────────────────────────────────┐
│  STUDENT GRADING - Telemetry Comparison View                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  TEACHER SUBMISSION VS STUDENT SUBMISSION                         │
│  ─────────────────────────────────────────────────────────────    │
│                                                                    │
│  Teacher Duration: 8000ms    Student Duration: 8120ms             │
│  Time Scale Factor: 0.985x (student ~1.5% slower)                │
│                                                                    │
│  ┌─────────────────────┬─────────────────────┬─────────────────┐  │
│  │ Time (ms)           │ Teacher Telemetry   │ Student Delta   │  │
│  ├─────────────────────┼─────────────────────┼─────────────────┤  │
│  │ 0.0                 │ LCD: ["..."]        │ ✅ MATCH        │  │
│  │                     │ I2C: START          │                 │  │
│  │                     │                     │                 │  │
│  │ 85.2                │ I2C: 0x48 0x01      │ ✅ MATCH        │  │
│  │ 87.5                │ I2C: 0x20 0xFF      │ ✅ MATCH        │  │
│  │                     │                     │                 │  │
│  │ 150.3               │ LCD: ["Hello"]      │ ❌ MISMATCH     │  │
│  │                     │ Expected time: 150ms│ Actual: 153ms   │  │
│  │                     │ Tolerance: ±5ms     │ Delta: +3ms ✅  │  │
│  │                     │                     │ PASS (within)   │  │
│  │                     │                     │                 │  │
│  │ 200-500             │ 8 I2C transactions  │ ✅ MATCH (7)    │  │
│  │ (random jitter)     │ (protocol activity) │ ~12.5% variance │  │
│  │                     │                     │ ⚠️  Note        │  │
│  │                     │                     │                 │  │
│  │ 1250.5              │ Serial: "Temp:"     │ ❌ MISSING      │  │
│  │                     │ Expected @ 1250ms   │ Not found in    │  │
│  │                     │                     │ student log     │  │
│  │                     │                     │ ❌ FAIL         │  │
│  │                     │                     │                 │  │
│  └─────────────────────┴─────────────────────┴─────────────────┘  │
│                                                                    │
│  SUMMARY                                                           │
│  ─────────────────────────────────────────────────────────────    │
│  Events matched: 24/28 (85.7%)                                    │
│  Missing events: 2                                                 │
│  Extra events: 2                                                   │
│  Timing tolerance: ±5ms                                            │
│                                                                    │
│  [Passed] ✅ Circuit behavior matches teacher solution            │
│           but with timing deviations acceptable                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 📱 Telemetry Console Log View

```
═══════════════════════════════════════════════════════════════════
  TELEMETRY EVENT STREAM  [0-8000ms]  [🔍 Search]  [📥 Import]  [📤 Export]
═══════════════════════════════════════════════════════════════════

🔽 [0ms]     BASELINE SNAPSHOT (10 component updates)
   └─ ComponentState: pico_28 → {txActive: false, rxActive: false, ...}
   └─ ComponentState: lcd_30 → {lines: ["        ", ...], illuminated: true}
   └─ ComponentState: buzzer_18 → {playing: false, frequency: 0, volume: 0}

📊 [85ms]    I2C COMMUNICATION STARTED
   └─ PinChange: LCD_SDA — LOW → HIGH (I2C Start bit)
   └─ PinChange: LCD_SCL — LOW → HIGH (clock sync)
   └─ ProtocolSignature: I2C [0x48, 0x01, 0x20, 0x00]
      (Device address 0x48, register read at offset 0x01)

✅ [95ms]    DATA RECEIVED - LCD UPDATED
   └─ ComponentState: lcd_30 → {lines[0]: "Hello World"}
   └─ ProtocolSignature: I2C [0x20, 0x48, 0x01]
      (Data byte response from I2C device)

⚠️  [97ms]    PROTOCOL ANOMALY DETECTED
   ⚠️  LCD is requesting data too frequently
   └─ Frequency: 5 requests per second
   └─ Recommendation: Add delay between I2C reads

🎵 [150ms]   AUDIO OUTPUT STARTED
   └─ ComponentState: buzzer_18 → {playing: true, frequency: 1000, volume: 80}
   └─ PinChange: buzzer_pin — PWM started (50% duty, 1kHz)

💾 [1250ms]  SERIAL DATA TRANSMITTED
   └─ SerialOutput (UART0) → "Temperature: 23.5°C\n"
   └─ SerialOutput (UART0) → "Humidity: 45%\n"

🔄 [2000ms]  SCHEDULED TELEMETRY REPORT
   └─ Summary: 89 events captured, 3 anomalies detected
   └─ I2C Transactions: 47 (avg 5.9ms/transaction)
   └─ Pin toggles: {D1: 2847, D2: 1203, D3: 89}

🎯 [8000ms]  SIMULATION ENDED
   └─ Final Statistics:
      • Total events: 234
      • Anomalies: 3 (all warnings)
      • Ignored events: 2
      • Export ready: TELEMETRY_8000ms.json

═══════════════════════════════════════════════════════════════════
```

---

## 🔧 Component Selection for Telemetry Monitoring

```
┌───────────────────────────────────────────────────────────┐
│  AVAILABLE COMPONENTS (Click to view telemetry)           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  BOARDS:                                                  │
│  ☐ wokwi-pi-pico_28                          [Active ✓]   │
│    └─ Telemetry: led, deepSilicon*                       │
│  ☐ wokwi-arduino-uno_1                       [Silent]     │
│    └─ Telemetry: leds, deepSilicon*                      │
│                                                           │
│  DISPLAYS:                                                │
│  ☑ wokwi-lcd2004-i2c_30                      [Active ✓]   │
│    └─ Telemetry: lines, illuminated, backlight           │
│  ☐ wokwi-ssd1306_31                          [Available]  │
│    └─ Telemetry: vram, contrast, displayOn               │
│  ☐ wokwi-led_22                              [Available]  │
│    └─ Telemetry: illuminated, brightness, color          │
│                                                           │
│  ACTUATORS:                                               │
│  ☐ wokwi-servo_25                            [Available]  │
│    └─ Telemetry: angle, pulseWidthMs, moving             │
│  ☑ wokwi-buzzer_18                           [Active ✓]   │
│    └─ Telemetry: playing, frequency, volume              │
│                                                           │
│  SENSORS:                                                 │
│  ☐ wokwi-dht22_19                            [Available]  │
│    └─ Telemetry: temperature, humidity, error            │
│  ☐ wokwi-hc-sr04_20                          [Available]  │
│    └─ Telemetry: distance, echoTimeMs                    │
│                                                           │
│  INPUT:                                                   │
│  ☐ wokwi-pushbutton_12                       [Available]  │
│    └─ Telemetry: pressed, bounceCount, voltage           │
│  ☐ wokwi-potentiometer_15                    [Available]  │
│    └─ Telemetry: angle, value, voltageOut                │
│                                                           │
│  PASSIVE/NO CUSTOM TELEMETRY:                            │
│  ☐ wokwi-diode_26                            [Pin-only]   │
│    └─ Telemetry: pins, pinToggles only                   │
│  ☐ wokwi-breadboard_half_2                   [Pin-only]   │
│    └─ Telemetry: connectivity via netlist                │
│                                                           │
│  ────────────────────────────────────────────────────────  │
│  Selected: 2 components                                   │
│  Active data streams: 4 metrics                           │
│  Est. overhead: 3-4%                                      │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

---

## 📈 Live Metrics Dashboard

```
SIMULATION HEALTH MONITOR (Live Update: Every 100ms)
────────────────────────────────────────────────────────────

🏗️  SIMULATION ENGINE PERFORMANCE
├─ Sim Speed:              1.0x (Real-time)
├─ Time Drift:             +2.3ms (acceptable)
├─ Execution Jitter:       ±0.8ms
├─ Frame Skips:            0 (smooth)
└─ Canvas FPS:             59.8 fps

📊 TELEMETRY COLLECTION OVERHEAD
├─ Mode:                   Deep
├─ Deep Silicon:           SRAM ☑️  Registers ☑️  Timers ☑️
├─ CPU Load (Worker):      6.2%
├─ Serialization Time:     2.1ms
└─ Telemetry Payload:      185 KB/s

🔌 COMPONENT ACTIVITY
├─ Active I2C Transfers:   4 (LCD)
├─ Active SPI Transfers:   0
├─ Active UART Transfers:  1 (debug output)
├─ Pin Toggling Freq:      1.2 kHz
└─ Electrical Noise:       +0.02V (normal)

💾 BUFFER & QUEUE STATUS
├─ Message Queue Lag:      1.3ms
├─ Worker Buffer:          68% full (245 KB / 360 KB)
├─ UI Main Thread Block:   0.0ms
└─ Memory Usage (Total):   124 MB

⚠️  ANOMALIES & WARNINGS
└─ None detected (system nominal)

✅ READY FOR GRADING
```

---

## Summary: How Telemetry Appears in UI

1. **During Simulation**: Right-side panel shows live component state + event log
2. **Component Selection**: F1 menu lets you choose which metrics to collect
3. **Grading View**: Side-by-side comparison of teacher vs student telemetry
4. **Performance**: Monitor CPU load, buffer usage, frame rate
5. **Export**: Download raw JSON logs for offline analysis
6. **Event Timeline**: Chronological view of all state changes and protocol traffic
7. **Anomaly Detection**: Automatic heuristic warnings (excessive retries, timing issues, etc.)

All data is **real-time**, **delta-optimized**, and **fully selectable** via the telemetry modal.

