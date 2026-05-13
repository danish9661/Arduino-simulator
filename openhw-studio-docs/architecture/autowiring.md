# OpenHW Studio: Intelligent Autowiring & Autocoding System

This document outlines the architecture, features, and component support status for the intelligent circuit generation engine.

## [LAUNCH] System Overview
The autowiring system is a hybrid engine (Rust WASM + TypeScript Worker) designed to automate the connection of complex components to microcontrollers (Arduino/ESP32). It handles both physical routing (wires) and logical initialization (code).

### Key Features
- **Dynamic Helper Injection**: Automatically adds required supporting hardware (e.g., L298N Motor Drivers, I2C Pull-up Resistors, External Power Supplies).
- **Smart Breadboard Provisioning**: Automatically adds and scales breadboards (Mini/Half/Full) based on circuit complexity.
- **Anchor-Pin Snapping**: Precisely aligns components to the breadboard hole grid for professional-grade layouts.
- **Manhattan Routing Engine**: Generates orthogonal, non-overlapping wiring paths with high-fidelity lane spacing (7px).
- **Universal Attribute Bridge**: Ensures high-fidelity serialization of electrical properties (e.g., 12V PSU readout, resistor color bands).

---

## 🛠 Component Support Status

### [OK] Fully Implemented (Autowiring + Autocoding)
These components feature automatic wiring, helper injection, and ready-to-run Arduino code.

| Component | Helper(s) Injected | Code Features |
| :--- | :--- | :--- |
| **DC Motor** | L298N Driver + 12V PSU | PWM speed control + Direction logic |
| **Stepper Motor** | L298N Driver + 12V PSU | Step sequencing + External power |
| **SSD1306 OLED** | 4.7kΩ I2C Pull-ups | Adafruit GFX/SSD1306 Initialization |
| **Servo Motor** | None (Direct) | Servo library sweep logic |
| **Potentiometer** | None (Direct) | Analog read + Serial monitoring |
| **Pushbutton** | 10kΩ Pull-down | Input pullup/down logic |
| **Ultrasonic (HC-SR04)** | None (Direct) | Distance calculation (cm) |
| **LED** | 220Ω Resistor | Basic blink/PWM logic |
| **Buzzer** | None (Direct) | Tone generation logic |
| **RGB LED** | 3x 220Ω Resistors | Multi-color cycle (Red/Green/Blue) |
| **Photoresistor (LDR)** | 10kΩ Voltage Divider | Analog light intensity (Lux) |
| **Temp Sensor (NTC)** | 10kΩ Voltage Divider | Beta-model temperature (Celsius) |

### 🚧 Partially Implemented (Universal Fallback)
These components use the universal wiring engine but may require manual code tweaks or manifest refinement.

| Component | Current Status | Notes |
| :--- | :--- | :--- |
| **PIR Sensor** | Wiring Only | Digital read implemented |
| **SD Card Module** | Wiring Only | SPI connections established |
| **MPU6050 Accel/Gyro** | Wiring Only | I2C connections established |

### [PENDING] Planned / Pending
- **Keypad 4x4**: Matrix wiring logic.
- **Relay Module**: Opto-coupler and high-power isolation logic.
- **ESP32 Support**: Mapping logic for 3.3V logic levels and WiFi initialization.

---

## 📐 Design Standards
- **Lane Spacing**: 7px (High-fidelity signal separation).
- **Safety Offset**: 10px from pin centers to prevent wire-on-pin collisions.
- **Wire Colors**:
  - `Red`: 5V / 3.3V
  - `Black`: GND
  - `Orange`: Digital Signals
  - `Green`: Analog Signals / Motor Terminals
  - `Blue`: I2C / Special Signals

---

## 🧪 Documentation & Walkthroughs
- Detailed implementation notes can be found in `C:\Users\Danish\Documents\simulator\openhw-studio-autowiring-engine\README.md`.
- Historical progress is tracked in the project's internal `walkthrough.md`.


