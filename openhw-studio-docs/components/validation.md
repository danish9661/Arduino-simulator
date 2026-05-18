# Circuit Validation Framework

OpenHW Studio features a native, unified **Circuit Validation Engine** that executes real-time electrical, physical, and safety checks on your virtual breadboards. The engine compiles and runs locally in your browser's web worker (or backend Node server) before simulation starts, shielding virtual microcontrollers and sensitive peripherals from destructive wiring, overcurrent damage, or short-circuits.

The validation pipeline consists of **Global Rules** (broad physical laws and network properties) and **Component-Specific Rules** (enforced by individual component definitions).

---

## Architecture & Core Mechanics

The validator models your breadboard as an electrical network graph where:
* **Vertices (Nodes)** represent components and their specific pins (e.g., `led_1.A` for the anode of `led_1`).
* **Edges** represent wires, breadboard rails, and traces linking pins together.

During validation, the engine constructs this graph and executes advanced graph-traversal and electrical algorithms:
1. **Resistive Path Finding**: Walks the graph using DFS/BFS to calculate in-line series resistance between power sources and nodes.
2. **Voltage Source Discovery (`collectVoltageSources`)**: Traces back from any pin to discover all contributing voltage points (e.g., 5.0V, 3.3V, 0V/GND) and registers potential conflicts.
3. **Logic Threshold Check**: Computes digital logic highs/lows and validates compatibility across different silicon architectures.

---

## The 24 Global Validation Rules

Here is a comprehensive breakdown of the global rules registered within the simulator's rules engine.

| Rule ID | Severity | Priority | Scope & Purpose |
| :--- | :--- | :--- | :--- |
| **`validateShortCircuits`** | `error` | 0 | **VCC-GND Direct Short Protection**: Scans the network graph to detect low-resistance paths linking active voltage rails directly to a common ground rail. Prevent deadlocks or infinite loop crashes in simulation. |
| **`validateRailConflicts`** | `error` | 5 | **Cross-Domain Rail Protection**: Detects direct electrical connections between different active supply domains (e.g., tying a 5.0V supply rail directly to a 3.3V supply rail), which would damage real-world components via backfeeding. |
| **`validateMcuPower`** | `error` | 10 | **Microcontroller Power Integrity**: Verifies that any active microcontroller (e.g., Arduino Uno, Raspberry Pi Pico) has its VCC/5V/3V3 pins connected to a valid supply, and its GND pins routed back to a common ground. |
| **`validateComponentLimits`** | `error` | 20 | **Component Current & Drive Limits**: Ensures physical components (like LEDs) do not exceed their maximum ratings, and checks that GPIO pins do not exceed maximum current draw (e.g., 20mA for ATmega328P, 16mA for RP2040). |
| **`validatePowerDissipation`** | `error` | 30 | **Passive Power Dissipation**: Calculates power dissipation ($P = I^2 \times R$ or $P = \frac{V^2}{R}$) for passive components like resistors to ensure they stay within physical wattage limits (typically 250mW / 0.25W). |
| **`validateReversePolarity`** | `warn` | 40 | **Reverse-Polarity Protection**: Flags polarized components (e.g., standard diodes, electrolytic capacitors, polarized LEDs) that are biased in reverse under active voltage, potentially causing leakage or degradation. |
| **`validateFloatingPins`** | `warn` | 50 | **Floating High-Impedance Inputs**: Scans digital input pins configured in code (e.g., `pinMode(pin, INPUT)`) that lack physical pull-up or pull-down connections, resulting in erratic, noise-prone states. |
| **`validateLogicLevels`** | `error` | 60 | **Silicon Logic Level Compatibility**: Flags direct digital logic mismatches (e.g., sending a 5V logic signal from an Arduino Uno to a 3.3V-only input on a sensor) without a bidirectional level shifter. |
| **`validateI2CPullups`** | `warn` | 70 | **I2C Bus Integrity**: Confirms that SCL (Clock) and SDA (Data) lines on an active I2C bus are tied to a supply rail via appropriate pull-up resistors (typically $4.7\text{k}\Omega$ or $10\text{k}\Omega$). |
| **`validateSerialPinConflict`** | `warn` | 80 | **UART Hardware Pin Collision**: Warns if hardware serial pins (D0/RX, D1/TX on Arduino Uno) are configured for general digital I/O while `Serial.begin()` is declared in code, preventing transmission corruption. |
| **`validateI2CDeviceWithoutMcu`** | `warn` | 90 | **Orphaned I2C Peripherals**: Flags I2C-enabled displays or sensors that are powered but lack active connection to an MCU master, rendering them non-functional. |
| **`validateLedFloatingPins`** | `warn` | 100 | **Orphaned LED Pins**: Identifies when either the Anode or Cathode of an LED is left unconnected, ensuring complete circuits. |
| **`validateRp2040VoltageInputs`** | `error` | 110 | **RP2040 Overvoltage Protection**: Specifically checks GPIO pins on Raspberry Pi Pico / RP2040 boards. Because RP2040 inputs are not 5V tolerant, direct connections above 3.6V will raise a critical safety error. |
| **`validateBuzzerResistor`** | `warn` | 120 | **Buzzer GPIO Load Warning**: Checks that piezo or electromagnetic buzzers driven directly by an MCU have a series current-limiting resistor to protect the GPIO driver. |
| **`validateDuplicateI2CAddress`** | `warn` | 130 | **I2C Address Collision**: Inspects I2C addresses (e.g. `0x27`, `0x3C`) of all peripherals on the same bus to ensure there are no duplicate slave addresses causing arbitration clashes. |
| **`validatePotentiometer`** | `warn` | 140 | **Potentiometer Short Protection**: Checks that the outer terminals of a potentiometer are not connected in a way that creates a direct VCC-GND short when the wiper is rotated to its extreme positions. |
| **`validateDiodePolarity`** | `warn` | 150 | **Diode Bias Check**: Inspects diodes in the system to verify they are connected in forward-bias configurations for the intended current routing path. |
| **`validateTotalPowerBudget`** | `warn` | 160 | **Power Budget Estimation**: Estimates total combined current consumption of all active modules against the power source's total budget (e.g., 500mA for standard USB, 1A for battery). |
| **`validateBatteryLife`** | `warn` | 180 | **Battery Life & Run Duration**: Estimates running duration in hours for battery-operated configurations based on active current consumption and battery capacity (mAh). |
| **`validateVoltageDrops`** | `warn` | 190 | **Line Voltage Drop**: Models internal wire and contact resistances to check if voltage drops across long cascades leave sensitive devices underpowered. |
| **`validateDeadlocks`** | `warn` | 200 | **Infinite Wait & Deadlock Analysis**: Inspects firmware structure to identify loops waiting indefinitely for signals from disconnected or unpowered sensors. |
| **`validateSignalIntegrity`** | `warn` | 210 | **High-Frequency Signal Integrity**: Analyzes routing paths for high-frequency signal buses (SPI, fast I2C) and warns about excessive trace lengths or cross-talk vulnerabilities. |
| **`validateCrossComponentInteractions`** | `warn` | 220 | **Inductive Kickback Protection**: Ensures inductive loads (motors, relays, solenoids) that share rails with sensitive MCUs are protected with flyback/freewheeling diodes and decoupling caps. |

---

## Under the Hood: Key Electrical Algorithms

### 1. Resistive Path Finding (`findSeriesResistance`)
To protect microcontrollers from overcurrent, the engine must know the absolute series resistance between a pin driving a load and the target power source. The engine does this by recursively walking through:
* Resistors (adding their resistance value to the path sum).
* Closed switches/pushbuttons (treated as ~0.1 $\Omega$).
* Closed relays, wires, and breadboard rails.

If a pathway reaches an MCU pin with less than $220\Omega$ total resistance (for a standard 5V LED, for example), the `validateComponentLimits` rule triggers an overcurrent violation.

### 2. Voltage Source Collection (`collectVoltageSources`)
```javascript
const sources = validator.collectVoltageSources(pinNode);
```
This utility traverses back from any node to identify all active inputs. If it discovers two positive sources with different voltages (e.g. `5.0V` and `3.3V`) on the same connected net, it raises a rail conflict. If it discovers a positive source and a ground source with no resistance in between, it raises a short-circuit error.

### 3. Logic Level Validation
Different components use different logic levels (e.g. CMOS 3.3V vs TTL 5V). The engine compares the logic high input threshold ($V_{IH}$) and logic low threshold ($V_{IL}$) of receivers with the output levels ($V_{OH}$ and $V_{OL}$) of the transmitter:
* If the transmitter's $V_{OH}$ is higher than the receiver's maximum input tolerance ($V_{IN\text{-}MAX}$), it flags an overvoltage risk.
* If the transmitter's minimum $V_{OH}$ falls below the receiver's required $V_{IH}$, it flags an unreliable logic state warning.
