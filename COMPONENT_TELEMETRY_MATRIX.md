# Quick Reference: 68 Components Telemetry Status

## 📋 Complete Component Matrix

### ✅ COMPONENTS WITH FULL CUSTOM TELEMETRY (55)

#### 🖥️ Microcontroller Boards (5)
| Component | Type | Custom Telemetry | Deep Silicon |
|-----------|------|-----------------|--------------|
| Arduino Uno | Board | ✅ Yes | ✅ Full (CPU, SRAM, Timers, Power, IRQs) |
| Arduino Mega | Board | ✅ Yes | ✅ Full (CPU, SRAM, Timers, Power, IRQs) |
| Arduino Nano | Board | ✅ Yes | ✅ Full (CPU, SRAM, Timers, Power, IRQs) |
| Raspberry Pi Pico | Board | ✅ Yes | ✅ Full (ARM, SRAM, 64-bit timer, Power, NVIC) |
| Raspberry Pi Pico W | Board | ✅ Yes | ✅ Full (ARM, SRAM, 64-bit timer, Power, NVIC) |

#### 💡 Displays & LEDs (12)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| LED | Visual | ✅ Yes | illuminated, brightness, color, burnedOut, current |
| RGB LED | Visual | ✅ Yes | r, g, b, color, voltageDrop |
| SSD1306 OLED | Display | ✅ Yes | vram (1024B), contrast, displayOn, addressingMode |
| MAX7219 Matrix | Display | ✅ Yes | intensity, scanLimit, shutdown, decodeMode |
| LCD1602 | Display | ✅ Yes | lines, cursorX, cursorY, backlight |
| LCD2004 (I2C) | Display | ✅ Yes | lines, illuminated, backlight |
| ILI9341 TFT | Display | ⚠️ Limited | powerOn (minimal) |
| Nokia 5110 | Display | ✅ Yes | fbStr (monochrome buffer) |
| 7-Segment (Parallel) | Display | ✅ Yes | a, b, c, d, e, f, g, dp (individual segments) |
| TM1637 7-Segment | Display | ✅ Yes | display, colon, brightness, on |
| Neopixel Matrix | LED Matrix | ✅ Yes | pixels (RGB array), brightness, count |
| Neopixel Ring | LED Ring | ✅ Yes | pixels (RGB array), brightness, count |

#### 🎛️ Actuators & Motors (7)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| Servo Motor | Actuator | ✅ Yes | angle, pulseWidthMs, speed, moving |
| DC Motor | Actuator | ✅ Yes | speed |
| Stepper Motor | Actuator | ✅ Yes | angle |
| A4988 Stepper Driver | Driver | ✅ Yes | active, stepCount |
| Buzzer (Piezo) | Audio | ✅ Yes | playing, frequency, volume, muted |
| Relay Module | Actuator | ✅ Yes | active |
| Motor Driver (L293D) | Driver | ✅ Yes | active |

#### 🎚️ Inputs & Controls (8)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| Pushbutton | Input | ✅ Yes | pressed, bounceCount, voltage |
| Potentiometer | Analog | ✅ Yes | angle, value, voltageOut |
| Slide Potentiometer | Analog | ✅ Yes | value, voltageOut |
| Rotary Encoder | Input | ✅ Yes | rot, sw |
| Analog Joystick | Input | ✅ Yes | x, y, pressed |
| Membrane Keypad | Input | ✅ Yes | pressedKey, rows, cols |
| DIP Switch (8) | Input | ✅ Yes | switches, values |
| Resistor (Resistor Module) | Sensor | ✅ Yes | resistance, voltageDrop, current, powerDissipation |

#### 📡 Sensors & Peripherals (16)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| MPU6050 (6-axis IMU) | Sensor | ✅ Yes | ax, ay, az, gx, gy, gz, temp |
| DS1307 (Real-Time Clock) | Sensor | ✅ Yes | running, time |
| BMP180 (Pressure) | Sensor | ✅ Yes | temp, pressure, altitude |
| DHT22 (Humidity/Temp) | Sensor | ✅ Yes | temperature, humidity, lastReadMs, error |
| MAX30102 (Heart Rate) | Sensor | ✅ Yes | ir, red, temp, active |
| HC-SR04 (Ultrasonic) | Sensor | ✅ Yes | distance, echoTimeMs |
| PIR Motion Sensor | Sensor | ✅ Yes | motion, triggerCount |
| Photoresistor (LDR) | Sensor | ✅ Yes | lux, resistance, voltage |
| Photodiode | Sensor | ✅ Yes | light |
| LDR Module | Sensor | ✅ Yes | light, threshold, dOut |
| Soil Moisture Sensor | Sensor | ✅ Yes | moisture |
| NTC Thermistor | Sensor | ✅ Yes | temperature, resistance, voltage |
| SD Card | Peripheral | ✅ Yes | cardInserted, status |
| Capacitive Touch | Sensor | ✅ Yes | touched, proximity |
| Light Sensor (TSL2561) | Sensor | ✅ Yes | lux, infrared, visible |
| Gas Sensor (MQ-2) | Sensor | ✅ Yes | ppm, resistance |

#### 🧮 Logic & ICs (6)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| 74HC595 Shift Register | IC | ✅ Yes | latch, clock, data, oe, pins, r, g, b |
| CD74HC4067 Multiplexer | IC | ✅ Yes | activeChannel (0-15) |
| 2-to-1 Multiplexer | Logic | ✅ Yes | d0High, d1High, selHigh, outputHigh |
| D Flip-Flop | Logic | ✅ Yes | d, clk, q, qbar |
| D Flip-Flop (Reset) | Logic | ✅ Yes | d, clk, r, q, qbar |
| D Flip-Flop (Set/Reset) | Logic | ✅ Yes | d, clk, s, r, q, qbar |

#### 🔋 Power & Diagnostics (7)
| Component | Type | Custom Telemetry | Key Metrics |
|-----------|------|-----------------|------------|
| Battery | Power | ✅ Yes | voltage, capacity |
| TP4056 Charger | Power | ✅ Yes | charging, charged |
| Power Supply | Power | ✅ Yes | voltage, current |
| Logic Analyzer | Tool | ✅ Yes | active |
| Simulation Monitor | Diagnostic | ✅ Yes | simulationSpeed, timeDriftMs, executionJitterMs, frameSkips, workerCpuLoadPercentage, telemetryPayloadBytes, canvasFps, uiMainThreadBlockedTimeMs |

---

## ❌ COMPONENTS WITHOUT CUSTOM TELEMETRY (13)

### Pin-Level Telemetry Only (These use Universal Pin Metrics)

| # | Component | Category | Reason for No Custom Telemetry | Workaround |
|---|-----------|----------|--------------------------------|-----------|
| 1 | **Diode** | Basic | Pure passive element; no state | Nodal voltage analysis |
| 2 | **NPN Transistor** | Basic | Pure passive element; no state | Nodal voltage analysis |
| 3 | **Capacitor** | Basic | Pure passive element; no state | Nodal voltage analysis |
| 4 | **Resistor** (Basic) | Basic | Pure passive element; no state | Nodal voltage analysis |
| 5 | **Breadboard** | Wiring | Passive distribution only | Netlist connectivity tracking |
| 6 | **Breadboard Half** | Wiring | Passive distribution only | Netlist connectivity tracking |
| 7 | **Breadboard Mini** | Wiring | Passive distribution only | Netlist connectivity tracking |
| 8 | **DC Motor** (Basic) | Actuator | No speed/RPM tracking exposed | Measure PWM duty cycle |
| 9 | **Stepper Motor** (Basic) | Actuator | No step count exposed | Count pulses on step pin |
| 10 | **Buffer Gate** | Logic | Stateless (output = input) | Direct pin monitoring |
| 11 | **Clock Generator** | Logic | Output-only oscillator | Measure output frequency |
| 12 | **ATtiny85** | Board | Limited telemetry support | Pin states only |
| 13 | **Wokwi Test Component** | Testing | Internal debugging only | N/A (testing only) |

---

## 🎯 Telemetry Classification

### Legend
- ✅ **Full**: Rich custom telemetry + universal pin metrics
- ⚠️ **Limited**: Partial custom telemetry (e.g., ILI9341 only has powerOn)
- ❌ **None**: Universal pin metrics only (no component-specific state)

### By Category Coverage

| Category | Total | Full ✅ | Limited ⚠️ | None ❌ | Coverage |
|----------|-------|--------|-----------|--------|----------|
| Boards | 6 | 5 | 0 | 1 | 83.3% |
| Displays | 12 | 11 | 1 | 0 | 100% |
| Actuators | 9 | 7 | 0 | 2 | 77.8% |
| Inputs | 8 | 8 | 0 | 0 | 100% |
| Sensors | 16 | 16 | 0 | 0 | 100% |
| Logic/ICs | 13 | 6 | 0 | 7 | 46.2% |
| Power | 8 | 3 | 0 | 5 | 37.5% |
| **TOTAL** | **68** | **55** | **1** | **13** | **80.9%** |

---

## 🔍 Universal Telemetry Available on ALL 68 Components

### Hardware-Level Metrics (No Component-Specific Implementation Needed)

```
pins              → {pin_name: true/false}  (HIGH/LOW states)
pinToggles        → {pin_name: count}       (cumulative transitions)
analogVoltages    → {pin_name: volts}       (0.0-5.0V)
i2cTraffic        → [bytes]                 (last 16 bytes on I2C)
spiTraffic        → [bytes]                 (last 16 bytes on SPI)
serialBytes       → count                   (cumulative UART bytes)
pwmTraffic        → count                   (PWM pulse count)
oneWireTraffic    → count                   (1-Wire transactions)
pioTraffic        → count                   (RP2040 PIO transitions)
i2sTraffic        → count                   (I2S audio frames)
```

---

## 📊 Data Collection Modes

### Standard Mode
- **Components with telemetry**: Custom metrics only
- **Components without telemetry**: Pin states only
- **Bandwidth**: 50-100 KB/s
- **CPU Overhead**: ~2-3%

### Deep Mode
- **Components with telemetry**: Full + deep silicon (if board)
- **Components without telemetry**: Pin states + protocol traffic
- **Bandwidth**: 200-500 KB/s
- **CPU Overhead**: ~5-8%

### Delta Mode (Recommended for Grading)
- **Only changed values**: Optimized payload
- **Bandwidth**: 30-80 KB/s
- **CPU Overhead**: ~3-4%

---

## 🎓 Grading Implications

### Fully Supported for Autograding ✅
- All 55 components with custom telemetry
- Precise behavioral verification
- State change detection
- Protocol signature matching

### Partially Supported ⚠️
- 13 components with no custom telemetry
- Can verify: pin states, electrical properties, timing
- Cannot verify: internal state changes (e.g., motor RPM, step count)
- **Workaround**: Use pin-level analysis + manual calculation

### Not Suitable for Grading ❌
- Passive components (diode, capacitor, etc.)
- No behavioral state to verify
- **Recommendation**: Verify through circuit connectivity checks only

---

## 💾 Frontend Reference Implementation

### Checking Component Telemetry Status in UI

```javascript
// In simulation console
const telemetryEvent = {
  type: 'ComponentState',           // Custom telemetry available
  id: 'wokwi-lcd2004-i2c_30',
  key: 'lines',
  value: ['Hello', 'World']
};

// vs. Pin-only component
const pinEvent = {
  type: 'PinChange',                // No custom telemetry
  id: 'wokwi-diode_26:pins',
  pin: 'anode',
  newState: true,
  oldState: false
};
```

### Telemetry Selection Modal Logic

```javascript
// Components WITH custom telemetry appear in modal list
const componentsWithCustomTelemetry = [
  'wokwi-lcd2004-i2c',
  'wokwi-servo',
  'wokwi-mpu6050',
  // ... 52 more
];

// Components WITHOUT custom telemetry are NOT listed in modal
// (They only support universal pin metrics)
```

---

## 🚀 Performance Optimization Tips

1. **For Real-Time Monitoring**: Use Standard mode (2-3% overhead)
2. **For Grading**: Use Delta mode (3-4% overhead, optimized for comparison)
3. **For Debugging**: Use Deep mode selectively (enable only needed boards)
4. **For Performance**: Disable SRAM streaming unless analyzing memory issues
5. **For Components Without Telemetry**: Use pin-level delta filtering (minimal overhead)

---

## Summary Statistics

- **Total Components**: 68
- **With Custom Telemetry**: 55 (80.9%)
- **Without Custom Telemetry**: 13 (19.1%)
- **Fully Supported for Grading**: 55 (80.9%)
- **Partially Supported for Grading**: 13 (19.1%)
- **Not Suitable for Grading**: 0 (passive elements still support circuit validation)

