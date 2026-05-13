# Autofix Engine Roadmap & Coverage Tracking

This document tracks the parity between the **Circuit Validation Engine** (the detector) and the **Rust Autofix Engine** (the repairman).

## [DATA] Summary Status
- **Total Rules**: 24
- **Autofixes Implemented**: 11
- **Coverage**: ~46%
- **Engine**: Rust WASM (v2.0.0)

---

## [OK] Implemented Autofixes
| Rule ID | Description | Repair Pattern | Status |
| :--- | :--- | :--- | :--- |
| `validateFloatingPins` | Detects unconnected MCU inputs | A* routing to GND/VCC | [x] |
| `validateLedFloatingPins`| Detects floating LED pins | A* routing to GND/Board | [x] |
| `validateReversePolarity`| Backwards LED | 180° Transformation (Flip) | [x] |
| `validateDiodePolarity` | Backwards Diode | 180° Transformation (Flip) | [x] |
| `validateComponentLimits`| LED over-current / No resistor | Resistor Injection + Wire Cut | [x] |
| `validateBuzzerResistor` | Buzzer over-current / No resistor| Resistor Injection + Wire Cut | [x] |
| `validateI2CPullups`    | Missing I2C resistors | Dual 4.7k Resistor Injection | [x] |
| `validateRp2040VoltageInputs`| 5V into 3.3V GPIO | Voltage Divider Injection | [x] |
| `validateRailConflicts`  | VCC-GND or 5V-3.3V tie | Error reporting (Hard Fix) | [/] |
| `validateShortCircuits` | Direct VCC-GND shorts | Path Removal suggestion | [x] |
| `potentiometer-floating-wiper`| Unconnected wiper | Auto-route to Analog pin | [x] |

---

## [PENDING] Pending / Future Improvements
| Rule ID | Description | Proposed Repair | Priority |
| :--- | :--- | :--- | :--- |
| `validateLogicLevels` | 5V MCU driving 3.3V device | Level Shifter Module Injection | High |
| `validateDuplicateI2CAddress` | Two devices on same address | Attribute auto-increment | Med |
| `validatePowerDissipation` | Resistor getting too hot | Auto-replace with higher watt / Parallel | Low |
| `validateI2CDeviceWithoutMcu`| I2C device with no brain | Suggest Arduino/Pico addition | Med |
| `validateSerialPinConflict` | Pins 0/1 used during upload | Move wires to higher pins | Low |
| `validateTotalPowerBudget` | Too many components for USB | Suggest Battery/External Supply | Low |
| `validateThermalLimits` | Component temp > 75°C | Suggest Heatsink addition | Low |
| `validateBatteryLife` | High drain on battery | Suggest larger Mah battery | Low |
| `validateVoltageDrops` | Rail sagging | Suggest thicker wires (Visual) | Low |
| `validateDeadlocks` | blocking while(1) loops | Code injection (non-blocking) | High |
| `validateSignalIntegrity`| Noise from motors | Decoupling Capacitor Injection | Med |
| `validateCrossComponentInteractions` | Mixed surge/sensitive | Separation & Bypass Caps | Med |

---

## [TOOL] Infrastructure Progress
- [x] **Rust Migration**: 100% (Legacy AS Engine removed)
- [x] **A* Pathfinding**: Optimized grid-based routing implemented.
- [x] **Unified Editor**: `applyProjectChangePlan` centralized in `projectUtils.js`.
- [x] **JS/WASM Bridge**: `wasm-bindgen` automated glue code.
- [x] **Validation Loop API**: "Speak & Hear" automation protocol.
- [ ] **Multi-Layer Routing**: Support for "Below board" wires.
- [ ] **Ghost Persistence**: Save repair reasoning to `diagram.json` metadata.

---
*Last Updated: May 2026*


