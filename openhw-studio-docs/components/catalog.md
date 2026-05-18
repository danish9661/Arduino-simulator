# Component Catalog

Welcome to the **OpenHW Studio Component Catalog**. This document provides a complete technical reference for all virtual electronic components available on the simulator canvas. Every component is modeled with realistic physical specifications, pin layouts, and specific safety rules.

---

## 1. Microcontrollers & Development Boards

Microcontrollers serve as the brain of your circuits. They run compiled firmware, generate PWM signals, read analog sensors, and communicate via digital protocols.

### Arduino Uno (`openhw-arduino-uno`)
* **Description**: The classic ATmega328P-based development board. Operating voltage is 5V.
* **Pinout**:
  * `5V`, `3.3V`, `GND` (3x), `RESET`, `IOREF`, `AREF`.
  * `A0` to `A5` (Analog Inputs / Digital GPIO).
  * `D0` to `D13` (Digital GPIO; D3, D5, D6, D9, D10, D11 support PWM).
* **Specifications**: Max GPIO source/sink: 20mA. Total board current limit: 200mA.
* **Validation Checks**:
  * **Rule `mcu-power-check`**: Warns if power pins (`5V`/`GND`) are shorted or miswired.
  * **Rule `serial-pin-clash`**: Checks if Pin 0/1 are used for GPIO while Serial is active.

### Arduino Nano (`openhw-arduino-nano`)
* **Description**: Compact version of the Uno using the ATmega328P. Excellent for breadboard layouts.
* **Pinout**: Identical to Uno, with additional analog input pins `A6` and `A7` (analog input only).
* **Specifications**: Max GPIO current: 20mA.

### Arduino Mega 2560 (`openhw-arduino-mega`)
* **Description**: Mega-sized development board powered by the ATmega2560.
* **Pinout**: 54 digital I/O pins (15 PWM), 16 analog inputs, and 4 UART serial ports.
* **Specifications**: Max GPIO current: 20mA.

### Raspberry Pi Pico (`openhw-pico`)
* **Description**: RP2040-based dual-core ARM Cortex-M0+ board operating at 3.3V.
* **Pinout**:
  * `GP0` to `GP22`, `GP26` to `GP28` (GPIO/ADC).
  * `VBUS` (5V USB power), `VSYS` (system input), `3V3` (output power), `AGND`, `GND`.
* **Specifications**: Max GPIO source/sink: 16mA (configurable). GPIO inputs are **not 5V tolerant**.
* **Validation Checks**:
  * **Rule `rp2040-overvoltage`**: Critical safety block if a voltage exceeding 3.6V is directly connected to any GP pin.

### Raspberry Pi Pico W (`openhw-pico-w`)
* **Description**: RP2040 Pico board featuring an onboard Infineon CYW43439 wireless chip for Wi-Fi and Bluetooth.
* **Pinout & Specs**: Identical to the standard Pico.

### ATtiny85 (`openhw-attiny85`)
* **Description**: Low-power 8-bit AVR microcontroller in an 8-pin DIP package.
* **Pinout**: `VCC`, `GND`, `PB0` to `PB5` (GPIO, ADC, PWM).
* **Specifications**: Operating range: 2.7V to 5.5V. Max GPIO current: 20mA.

---

## 2. Discrete Passive Components

Passives restrict current flow, store charge, protect components, or buffer signals.

### Resistor (`openhw-resistor`)
* **Description**: Two-terminal linear passive resistor. Limits current flow.
* **Pins**: `1`, `2` (Bi-directional).
* **Attributes**: `value` (resistance in Ohms, e.g., `220`, `10k`), `powerRating` (default `0.25` Watts).
* **Validation Checks**:
  * **Rule `resistor-wattage`**: Calculates $P = I^2 \times R$. Raises a safety warning if the calculated dissipation exceeds the power rating (e.g. putting $10\Omega$ directly across 5V).

### Potentiometer & Slide Potentiometer (`openhw-potentiometer` / `openhw-slide-potentiometer`)
* **Description**: Three-terminal variable resistor with a sliding/rotating wiper.
* **Pins**:
  * `1` (Terminal A), `2` (Wiper), `3` (Terminal B).
* **Attributes**: `value` (total resistance, e.g., `10k`).
* **Validation Checks**:
  * **Rule `potentiometer-wiring-safety`**: Warns if Terminals 1 and 3 are left unconnected, or if Wiper 2 is wired directly to VCC and GND with 0$\Omega$ resistance, preventing a short-circuit when swept to maximum or minimum.

### Diode (`openhw-diode`)
* **Description**: Two-terminal semiconductor that permits current flow in one direction only.
* **Pins**: `A` (Anode), `K` (Cathode).
* **Specifications**: Forward voltage drop ($V_f$): 0.7V. Reverse breakdown: 50V.
* **Validation Checks**:
  * **Rule `diode-reverse-voltage`**: Warns if the cathode is subjected to a voltage higher than the anode by more than the reverse breakdown voltage.

### NPN Transistor (`openhw-npn-transistor`)
* **Description**: Bipolar Junction Transistor (BJT) used for switching and amplification.
* **Pins**: `C` (Collector), `B` (Base), `E` (Emitter).
* **Validation Checks**:
  * **Rule `npn-base-resistor`**: Warns if the Base (B) pin is directly driven by an MCU GPIO without a current-limiting resistor, which would burn out the base-emitter junction.

---

## 3. Indicators & Outputs

Indicators translate electrical signals into light or sound.

### Light Emitting Diode (`openhw-led`)
* **Description**: Polarized semiconductor light source.
* **Pins**: `A` (Anode), `K` (Cathode).
* **Attributes**: `color` (`red`, `green`, `blue`, `yellow`, `white`).
* **Physical Specs**: Forward voltage drop: 2.0V (Red/Yellow) to 3.2V (Blue/White/Green). Max current: 20mA.
* **Validation Checks**:
  * **Rule `led-floating-pins`**: Warns if either Anode or Cathode is left disconnected.
  * **Rule `led-overcurrent`**: Critical error if the forward current exceeds 30mA (e.g. driving an LED directly from an Arduino Pin without a 220$\Omega$ series resistor).

### RGB LED (`openhw-rgb-led`)
* **Description**: 4-pin LED containing Red, Green, and Blue junctions in one package.
* **Pins**: `R` (Red Anode), `G` (Green Anode), `B` (Blue Anode), `COM` (Common Cathode / Common Anode).

### Buzzer (`openhw-buzzer`)
* **Description**: Piezoelectric or magnetic transducer that produces sound.
* **Pins**: `1` (Positive), `2` (GND).
* **Validation Checks**:
  * **Rule `buzzer-series-resistor`**: Warns if connected directly to MCU GPIOs without a series resistor or driver transistor.

### NeoPixel Ring & NeoPixel Matrix (`openhw-neopixel-ring` / `openhw-neopixel-matrix`)
* **Description**: Individually addressable RGB LEDs using the WS2812B protocol.
* **Pins**: `VCC` (5V), `GND`, `DIN` (Data In), `DOUT` (Data Out).
* **Specifications**: Typical current: 60mA per pixel at full white brightness.
* **Validation Checks**:
  * **Rule `neopixel-power-load`**: Warns if a matrix with more than 8 pixels is powered directly from the MCU's `5V` regulator without an external power supply.

---

## 4. Display Modules

Visual interfaces for displaying text, values, charts, or images.

### LCD1602 / LCD1602 I2C / LCD2004 I2C (`openhw-lcd1602` / `openhw-lcd1602-i2c` / `openhw-lcd2004-i2c`)
* **Description**: Character LCDs displaying text (16x2 or 20x4). The I2C versions include a PCF8574 expansion backplane to reduce wiring.
* **Pins (Standard)**: `VSS` (GND), `VDD` (5V), `V0` (Contrast), `RS`, `RW`, `E`, `D0` to `D7`, `A` (Backlight Anode), `K` (Backlight Cathode).
* **Pins (I2C)**: `GND`, `VCC`, `SDA`, `SCL`.
* **Validation Checks**:
  * **Rule `lcd-i2c-connections`**: Confirms power, ground, and I2C lines are active and routed to an MCU with pull-ups.

### SSD1306 OLED Display (`openhw-ssd1306-oled`)
* **Description**: High-contrast monochrome $128\times64$ dot-matrix screen utilizing the SSD1306 controller via I2C.
* **Pins**: `GND`, `VCC` (3.3V or 5V), `SCL`, `SDA`.
* **Validation Checks**:
  * **Rule `ssd1306-i2c-interface-check`**: Warns if I2C SDA/SCL lines are floating, or if `VCC`/`GND` connections do not reach the correct power supply rails.

### Nokia 5110 Display (`openhw-nokia-5110`)
* **Description**: Classic $84\times48$ pixel graphic LCD driven by the PCD8544 controller over SPI.
* **Pins**: `RST`, `CE` (Chip Select), `DC` (Data/Command), `DIN`, `CLK`, `VCC`, `LIGHT` (Backlight), `GND`.

### ILI9341 TFT Display (`openhw-ili9341`)
* **Description**: $320\times240$ color TFT screen driven by the ILI9341 controller using high-speed SPI.
* **Pins**: `VCC`, `GND`, `CS`, `RESET`, `DC`, `SDI` (MOSI), `SCK`, `LED` (Backlight), `SDO` (MISO).

---

## 5. Actuators & Drivers

Actuators create movement, while drivers act as high-power bridges.

### DC Motor (`openhw-motor`)
* **Description**: Direct current motor. Speed is regulated via voltage or PWM.
* **Pins**: `1`, `2`.
* **Specifications**: Typical operating voltage: 3V to 6V. Stall current: up to 1.2A.
* **Validation Checks**:
  * **Rule `motor-direct-drive`**: Critical safety warning if connected directly to an MCU GPIO pin, which cannot supply the required current and lacks flyback protection.

### Stepper Motor (`openhw-stepper-motor`)
* **Description**: Multi-phase brushless DC motor used for precise rotational steps.
* **Pins**: `A+`, `A-`, `B+`, `B-` (4-wire bipolar setup).

### Servo Motor (`openhw-servo`)
* **Description**: Positional rotary actuator containing internal gearing and feedback control.
* **Pins**: `PWM` (Signal), `V+` (Power), `GND` (Ground).
* **Validation Checks**:
  * **Rule `servo-power-and-signal-check`**: Warns if any of the three pins are disconnected or floating.

### L293D Dual H-Bridge & A4988 Stepper Driver (`openhw-l293d` / `openhw-a4988`)
* **Description**: High-power motor driver ICs. The L293D drives two DC motors; the A4988 drives a bipolar stepper motor using microstepping.
* **Pins (L293D)**: `1,2EN`, `1A`, `1Y`, `GND` (4x), `VCC1` (5V logic), `VCC2` (Motor power), `2A`, `2Y`, `3A`, `3Y`, `4A`, `4Y`, `3,4EN`.
* **Pins (A4988)**: `ENABLE`, `MS1`, `MS2`, `MS3`, `RESET`, `SLEEP`, `STEP`, `DIR`, `VMOT`, `GND` (2x), `VDD`, `1A`, `1B`, `2A`, `2B`.

### Relay Module (`openhw-relay-module`)
* **Description**: Electrically operated electromagnetic switch providing isolation between low-power logic and high-power loads.
* **Pins**: `IN` (Control), `VCC`, `GND` (Input side); `NO` (Normally Open), `COM` (Common), `NC` (Normally Closed) (Output side).

---

## 6. Sensors

Sensors translate environmental conditions into analog voltages or digital signals.

### HC-SR04 Ultrasonic Sensor (`openhw-hc-sr04`)
* **Description**: Non-contact distance measurement sensor using ultrasonic sound pulses.
* **Pins**: `VCC` (5V), `TRIG` (Trigger input), `ECHO` (Echo output), `GND`.
* **Validation Checks**:
  * **Rule `hcsr04-echo-level-check`**: Warns if the 5V `ECHO` output is directly connected to a 3.3V MCU (like Raspberry Pi Pico) without a voltage divider resistor network.

### NTC Temperature Sensor & NTC Thermistor (`openhw-ntc-temperature-sensor` / `openhw-ntc-thermistor`)
* **Description**: Negative Temperature Coefficient temperature measurement sensors. The module version includes an integrated op-amp to output clean analog and digital signals.
* **Pins (Thermistor)**: `1`, `2` (Passive resistance).
* **Pins (Sensor Module)**: `VCC`, `GND`, `AO` (Analog Out), `DO` (Digital Out).

### Soil Moisture Sensor (`openhw-soil-moisture-sensor`)
* **Description**: Soil moisture probe measuring volumetric water content based on electrical conductivity.
* **Pins**: `VCC`, `GND`, `AO` (Analog Out), `DO` (Digital Out).

### BMP180 Pressure & Temp Sensor (`openhw-bmp180`)
* **Description**: High-precision barometric pressure sensor using the I2C protocol.
* **Pins**: `VCC`, `GND`, `SDA`, `SCL`.

### MAX30102 Heart Rate Sensor (`max30102`)
* **Description**: Pulse oximeter and heart-rate sensor module using red/IR LEDs and photodetectors communicating over I2C.
* **Pins**: `VIN`, `GND`, `SDA`, `SCL`, `INT` (Interrupt).

### DS1307 Real-Time Clock (`openhw-ds1307-rtc`)
* **Description**: Low-power, full binary-coded decimal (BCD) real-time clock chip.
* **Pins**: `VCC`, `GND`, `SDA`, `SCL`, `BAT` (Backup battery connection).

### Rotary Encoder (`openhw-rotary-encoder`)
* **Description**: Rotational input device returning gray-code pulse transitions indicating direction and speed of rotation. Includes a push button.
* **Pins**: `CLK`, `DT`, `SW` (Switch), `VCC`, `GND`.

---

## 7. Storage, Expansion & Logic ICs

These chips expand the capability of microcontrollers, providing memory, extra pins, or hardware logic.

### SD Card Module (`openhw-sd-card`)
* **Description**: SPI-based flash memory card storage reader.
* **Pins**: `GND`, `VCC` (5V/3.3V), `MISO`, `MOSI`, `SCK`, `CS`.

### CD74HC4067 Multiplexer (`openhw-cd74hc4067`)
* **Description**: 16-channel analog multiplexer/demultiplexer. Routes one shared signal to 1 of 16 pins.
* **Pins**: `SIG` (Signal), `S0` to `S3` (Select lines), `EN` (Enable), `VCC`, `GND`, `C0` to `C15` (Channels).

### PCA9685 PWM Driver (`openhw-pca9685`)
* **Description**: 16-channel, 12-bit PWM I2C-bus controller optimized for driving servos and LEDs.
* **Pins**: `VCC`, `GND`, `SDA`, `SCL`, `OE` (Output Enable), and 16 channels of 3-pin headers (`PWM`, `V+`, `GND`).

### 74HC595 / NLSF595 Shift Register (`openhw-nlsf595` / `shift_register`)
* **Description**: 8-bit serial-in, parallel-out shift register. Converts three serial control pins into eight parallel outputs.
* **Pins**: `QA` to `QH` (Outputs), `GND`, `QH'` (Serial Out), `VCC`, `SER` (Serial Data), `OE` (Output Enable), `RCLK` (Latch), `SRCLK` (Clock), `SRCLR` (Clear).

### Digital Logic Gates & Flip-Flops
* **Types**: AND (`logic-and-gate`), OR (`logic-or-gate`), NOT (`logic-not-gate`), NAND (`logic-nand-gate`), NOR (`logic-nor-gate`), XOR (`logic-xor-gate`), XNOR (`logic-xnor-gate`), 2-to-1 MUX (`logic-mux-2to1`), D-FlipFlop (`logic-d-flipflop`), Clock Generator (`logic-clock-generator`), 74xx gate ICs (`logic-ic-74xx`).
* **Description**: Standard Boolean logic blocks used to build discrete logic networks.

---

## 8. Power & Prototyping Utilities

Utility components that distribute power and facilitate prototyping.

### Breadboard / Half / Mini (`openhw-breadboard` / `openhw-breadboard-half` / `openhw-breadboard-mini`)
* **Description**: Standard solderless prototyping boards. Wires attached to any pin on a 5-pin vertical column are automatically connected.
* **Validation Checks**:
  * **Breadboard Rail Verification**: Tracks that positive supply rails (red) and ground rails (blue) are not bridged together.

### Power Supply Module (`openhw-power-supply`)
* **Description**: Dual-rail breadboard power supply regulating USB/DC input down to selectable 3.3V or 5V rails.
* **Pins**: `V+` (3.3V/5V selectable), `GND`.

### Battery & Charger (`openhw-battery` / `openhw-charger`)
* **Description**: 3.7V LiPo or 9V battery modules coupled with micro-USB TP4056 chargers to simulate standalone portable electronics.
