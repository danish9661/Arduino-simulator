# OpenHW Studio Component Telemetry Reference

This document serves as the master reference for all component-level telemetry parameters exposed by the OpenHW Studio simulation engine. Each component reports its internal state, electrical properties, and custom metrics during high-frequency simulation loops, allowing the frontend console, logic analyzer, and delta-filtering engine to monitor hardware behavior with zero overhead.

---

## 🌐 Universal Telemetry (Available on ALL Boards & Components)

Because every simulation entity inherits from the master `BaseComponent` class, the following hardware-level parameters are **automatically available across 100% of components and microcontroller boards**. They can be selected in the Telemetry Selection Modal and monitored via O(1) Delta filtering:

| Parameter Name | Description |
| :--- | :--- |
| `pins` | Tracks the live digital logic state (HIGH `true` / LOW `false`) of all active pins on the component or board. |
| `pinToggles` | Tracks the cumulative number of times each individual pin transitioned between HIGH and LOW during simulation. |
| `analogVoltages` | Tracks the live simulated analog voltage level (in Volts) across all active pins. |
| `i2cTraffic` | Contains the most recent 16 bytes transmitted or received by the component over the I2C bus. |
| `spiTraffic` | Contains the most recent 16 bytes transmitted or received by the component over the SPI bus. |
| `serialBytes` | Tracks the cumulative byte volume transmitted via hardware UART or SoftwareSerial. |
| `pwmTraffic` | Tracks the cumulative count of PWM pulses or duty cycle updates processed on the component pins. |
| `oneWireTraffic` | Tracks the cumulative count of 1-Wire protocol reset and bit-write transactions. |
| `pioTraffic` | Tracks the cumulative count of Programmable I/O (PIO) state machine pin transitions. |
| `i2sTraffic` | Tracks the cumulative count of I2S digital audio frames transmitted or received. |

---

## ⚡ Microcontroller Boards

Microcontroller board components expose telemetry primarily for their onboard diagnostic LEDs, as well as optional **Deep Silicon Debugging** metrics (`deepSiliconRegisters`, `deepSiliconSRAM`, `deepSiliconTimers`, `deepSiliconPower`, `deepSiliconInterrupts`) when enabled via the F1 Quick Actions menu.

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-arduino-uno`<br>`wokwi-arduino-uno` | `leds` (`l`, `tx`, `rx`, `pwr`)<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks onboard LEDs. When Deep Silicon Debugging is enabled, streams live CPU registers (`PC`, `SP`, `SREG`, `cycles`), 2,048 bytes of SRAM, hardware timers (`TCNT0-2`), WDT/sleep modes, and pending IRQs. |
| `openhw-arduino-mega`<br>`wokwi-arduino-mega` | `leds` (`l`, `tx`, `rx`, `pwr`)<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks onboard LEDs, CPU registers, SRAM, hardware timers, power domains, and interrupts. |
| `openhw-arduino-nano`<br>`wokwi-arduino-nano` | `leds` (`l`, `tx`, `rx`, `pwr`)<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks onboard LEDs, CPU registers, SRAM, hardware timers, power domains, and interrupts. |
| `openhw-pico`<br>`wokwi-pi-pico` | `led`<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks GP25 LED. When Deep Silicon Debugging is enabled, streams ARM core registers, SRAM snapshots, 64-bit microsecond timer, clock domains, and NVIC IRQs. |
| `openhw-pico-w`<br>`wokwi-pi-pico-w` | `led`<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks CYW43 LED, ARM core registers, SRAM snapshots, microsecond timer, clock domains, and NVIC IRQs. |
| `openhw-attiny85`<br>`wokwi-attiny85` | `pins`<br>`deepSiliconRegisters`<br>`deepSiliconSRAM`<br>`deepSiliconTimers`<br>`deepSiliconPower`<br>`deepSiliconInterrupts` | Tracks active pin states, CPU registers, SRAM snapshots, timers, power domains, and interrupts. |

### 🔬 Deep Silicon Debugging & Modal Filtering
When **Deep Silicon Debugging** is toggled ON in the F1 menu, the simulation runner extracts internal silicon state and attaches it to the board's telemetry tree under `entry.details.deepSilicon`. 

To give you complete bandwidth control, you can filter this data using the **Select Telemetry Components** modal:
* **`deepSiliconRegisters`**: Streams lightweight CPU Core & Execution State (`PC`, `SP`, `SREG`, `cycles`).
* **`deepSiliconSRAM`**: Streams the full 2,048-byte memory map. If unchecked, the runner skips memory slicing entirely, saving massive Web Worker bandwidth!
* **`deepSiliconTimers`**: Streams Internal Hardware Timers & Prescalers (`TCNT0`, `TCNT1`, `TCNT2`, or RP2040 64-bit time).
* **`deepSiliconPower`**: Streams Power Domains & Watchdog Timer status (`WDT` enable/timeout, `sleepMode`).
* **`deepSiliconInterrupts`**: Streams Interrupt Controller status (Global `SREG.I` enable flag and pending IRQ vectors).

---

## 💡 Displays & Visual Indicators

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-led`<br>`wokwi-led` | `illuminated`, `brightness`, `color`, `burnedOut`, `glow`, `voltageDrop`, `current` | Tracks illumination status, PWM brightness, forward voltage drop, current draw in mA, and overcurrent burnout faults. |
| `openhw-rgb-led`<br>`wokwi-rgb-led` | `color`, `r`, `g`, `b`, `voltageDrop` | Tracks individual Red, Green, and Blue channel intensities and composite hex color representation. |
| `openhw-ssd1306-oled`<br>`wokwi-ssd1306` | `vram`, `invert`, `allOn`, `displayOn`, `displayStartLine`, `segmentRemap`, `comScanDir`, `displayOffset`, `vramDirty`, `updateCount`, `powerStatus`, `displayMode`, `contrast`, `vramFillPercentage`, `addressingMode` | Comprehensive OLED telemetry tracking the 1024-byte VRAM buffer, active addressing modes (Page/Horiz/Vert), hardware contrast, inversion state, and active pixel fill percentage. |
| `openhw-max7219`<br>`wokwi-max7219-matrix` | `intensity`, `scanLimit`, `shutdown`, `decodeMode`, `updateCount` | Tracks the MAX7219 SPI display driver state, including brightness intensity (0-15), active scan limit, shutdown mode status, and BCD decode mode configuration. |
| `openhw-lcd1602`<br>`wokwi-lcd1602` | `cursorX`, `cursorY`, `backlight`, `lines`, `illuminated` | Tracks the 16x2 character display buffer (`lines`), current cursor coordinates, and backlight illumination status. |
| `openhw-lcd1602-i2c`<br>`openhw-lcd2004-i2c` | `lines`, `illuminated`, `backlight` | Tracks the I2C-expanded character display buffer (`lines`) and backlight relay state. |
| `openhw-ili9341`<br>`wokwi-ili9341` | `powerOn`, `t` | Tracks the TFT display power state and frame update timestamps. |
| `openhw-nokia-5110`<br>`wokwi-nokia-5110` | `fbStr` | Tracks the serialized PCD8544 monochrome framebuffer string representation. |
| `openhw-7segment`<br>`wokwi-7segment` | `a`, `b`, `c`, `d`, `e`, `f`, `g`, `dp` | Tracks the individual active logic states of all 7 display segments plus the decimal point. |
| `openhw-tm1637-7segment`<br>`wokwi-tm1637-7segment` | `display`, `colon`, `brightness`, `on` | Tracks the 4-digit character buffer (`display`), center colon indicator, brightness level (0-7), and power state. |
| `openhw-neopixel-matrix`<br>`wokwi-neopixel-matrix` | `pixels`, `brightness`, `count` | Tracks the RGB color array buffer (`pixels`) for the entire LED matrix, global brightness, and total pixel count. |
| `openhw-neopixel-ring`<br>`wokwi-neopixel-ring` | `pixels`, `brightness`, `count` | Tracks the RGB color array buffer (`pixels`) for the circular Neopixel ring. |
| `openhw-ws2812b`<br>`wokwi-ws2812b` | `pixels`, `brightness`, `count` | Tracks the RGB color array buffer (`pixels`) for addressable LED strips. |

---

## 🎛️ Actuators, Motors & Audio

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-servo`<br>`wokwi-servo` | `angle`, `pulseWidthMs`, `speed`, `moving` | Tracks the physical servo horn angle (0-180°), incoming PWM pulse width in milliseconds, rotational speed, and active motion state. |
| `openhw-motor`<br>`wokwi-motor` | `speed` | Tracks the DC motor rotational speed resulting from applied voltage/PWM. |
| `openhw-stepper-motor`<br>`wokwi-stepper-motor` | `angle` | Tracks the precise rotational angle of the bipolar stepper motor shaft. |
| `openhw-a4988`<br>`wokwi-a4988` | `active`, `stepCount` | Tracks the A4988 stepper driver active enable state and accumulated step pulses. |
| `openhw-buzzer`<br>`wokwi-buzzer` | `playing`, `isBuzzing`, `frequency`, `volume`, `muted` | Tracks active piezo buzzer tone generation, output frequency in Hz, volume, and mute status. |
| `openhw-relay-module`<br>`wokwi-relay` | `active` | Tracks the electromechanical relay coil state (energized/active vs de-energized). |
| `openhw-motor-driver`<br>`openhw-l293d` | `active` | Tracks the dual H-bridge motor driver enable and channel switching states. |

---

## 🎚️ Inputs & Interactive Controls

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-pushbutton`<br>`wokwi-pushbutton` | `pressed`, `bounceCount`, `voltage` | Tracks the physical button press state, mechanical contact bounce counter, and output pin voltage. |
| `openhw-resistor`<br>`wokwi-resistor` | `resistance`, `voltageDrop`, `current`, `powerDissipation` | Tracks nominal resistance in Ohms, forward voltage drop, current draw, and power dissipation in Watts. |
| `openhw-potentiometer`<br>`wokwi-potentiometer` | `angle`, `value`, `voltageOut` | Tracks rotary knob wiper angle, normalized percentage value (0-100), and divided output voltage. |
| `openhw-slide-potentiometer`<br>`wokwi-slide-potentiometer` | `value`, `voltageOut` | Tracks linear slider wiper position (0-100) and divided output voltage. |
| `openhw-rotary-encoder`<br>`wokwi-ky-040` | `rot`, `sw` | Tracks accumulated rotary encoder detent steps (`rot`) and the integrated pushbutton switch state (`sw`). |
| `openhw-membrane-keypad`<br>`wokwi-membrane-keypad` | `pressedKey`, `rows`, `cols` | Tracks the active matrix row/col scanning lines and the currently depressed character key. |
| `openhw-analog-joystick`<br>`wokwi-analog-joystick` | `x`, `y`, `pressed` | Tracks dual-axis potentiometer positions (`x`, `y` from 0.0 to 1.0) and the integrated Z-axis pushbutton. |
| `openhw-dip-switch-8`<br>`wokwi-dip-switch-8` | `switches`, `values` | Tracks the individual binary states of all 8 slide switches in the DIP package. |

---

## 📡 Sensors & Advanced Peripherals

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-mpu6050`<br>`wokwi-mpu6050` | `ax`, `ay`, `az`, `gx`, `gy`, `gz`, `temp` | Tracks 3-axis accelerometer values (`ax`, `ay`, `az` in g), 3-axis gyroscope angular velocities (`gx`, `gy`, `gz` in °/s), and internal die temperature. |
| `openhw-ds1307-rtc`<br>`wokwi-ds1307` | `running`, `time` | Tracks the I(2)C Real-Time Clock oscillator status (`running`) and current simulated ISO timestamp. |
| `openhw-bmp180`<br>`wokwi-bmp180` | `temp`, `pressure`, `altitude` | Tracks barometric pressure in Pascals, ambient temperature in °C, and calculated altitude in meters. |
| `openhw-dht22`<br>`wokwi-dht22` | `temperature`, `humidity`, `lastReadMs`, `error` | Tracks relative humidity (%), temperature (°C), last sensor polling timestamp, and protocol checksum errors. |
| `max30102`<br>`wokwi-max30102` | `ir`, `red`, `temp`, `active` | Tracks optical photoplethysmography IR and Red LED reflectance ADC counts, die temperature, and active status. |
| `openhw-hc-sr04`<br>`wokwi-hc-sr04` | `distance`, `echoTimeMs` | Tracks the simulated obstacle distance in centimeters and the resulting ultrasonic echo pulse duration. |
| `openhw-pir-motion-sensor`<br>`wokwi-pir-motion-sensor` | `motion`, `triggerCount` | Tracks active passive infrared motion detection latching and cumulative trigger events. |
| `openhw-photoresistor`<br>`wokwi-photoresistor-sensor` | `lux`, `resistance`, `voltage` | Tracks simulated ambient illuminance in Lux, resulting LDR resistance, and voltage divider output. |
| `openhw-photodiode`<br>`wokwi-photodiode` | `light` | Tracks incident light level falling on the photodiode junction. |
| `openhw-ldr-module`<br>`wokwi-ldr-module` | `light`, `threshold`, `dOut` | Tracks analog light level, onboard comparator potentiometer threshold, and the resulting digital output pin state (`dOut`). |
| `openhw-soil-moisture-sensor`<br>`wokwi-soil-moisture-sensor`| `moisture` | Tracks simulated volumetric water content percentage (0-100%). |
| `openhw-ntc-thermistor`<br>`wokwi-ntc-temperature-sensor`| `temperature`, `resistance`, `voltage` | Tracks simulated temperature in °C, NTC thermistor resistance, and analog voltage output. |
| `openhw-sd-card`<br>`wokwi-sd-card` | `cardInserted`, `status` | Tracks SPI SD card insertion state, initialization status, and active SPI command responses. |

---

## 🧮 Logic Gates & Integrated Circuits

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `shift_register`<br>`openhw-nlsf595`<br>`wokwi-74hc595` | `latch`, `clock`, `data`, `oe`, `pins`, `r`, `g`, `b` | Tracks shift register control lines (ST_CP, SH_CP, DS, OE), parallel output pin states (`pins`), and RGB channel mappings. |
| `openhw-cd74hc4067`<br>`wokwi-cd74hc4067` | `activeChannel` | Tracks the currently selected analog/digital multiplexer channel (0-15) based on the 4 address select lines. |
| `logic-mux-2to1` | `d0High`, `d1High`, `selHigh`, `outputHigh` | Tracks the logic states of input D0, input D1, the Select line, and the resulting multiplexed output. |
| `logic-d-flipflop` | `d`, `clk`, `q`, `qbar` | Tracks Data input, Clock input, output Q, and inverted output Q-bar. |
| `logic-d-flipflop-r` | `d`, `clk`, `r`, `q`, `qbar` | Tracks Data, Clock, asynchronous Reset, output Q, and inverted output Q-bar. |
| `logic-d-flipflop-dsr` | `d`, `clk`, `s`, `r`, `q`, `qbar` | Tracks Data, Clock, asynchronous Set, asynchronous Reset, output Q, and inverted output Q-bar. |
| `logic-clock-generator` | `out` | Tracks the oscillating digital output square wave state. |
| `logic-ic-74xx` | `icType`, `outputs` | Tracks the specific 74-series TTL logic IC model (e.g., 7408, 7400, 7432) and the logic states of all output pins. |

---

## 🔋 Power, Wiring & Diagnostics

| Component Name / Type | Telemetry Parameters | Description |
| :--- | :--- | :--- |
| `openhw-battery`<br>`wokwi-battery` | `voltage`, `capacity` | Tracks battery terminal voltage and remaining charge capacity percentage. |
| `openhw-charger`<br>`wokwi-tp4056` | `charging`, `charged` | Tracks TP4056 LiPo charging status indicator LEDs (Charging vs Fully Charged). |
| `openhw-power-supply`<br>`wokwi-power-supply` | `voltage`, `current` | Tracks regulated output voltage and current draw. |
| `openhw-logic-analyzer`<br>`wokwi-logic-analyzer` | `active` | Tracks whether the virtual logic analyzer is actively sampling digital channels. |
| `openhw-simulation-monitor` | `simulationSpeed`, `timeDriftMs`, `executionJitterMs`, `frameSkips`, `workerBufferLatency`, `workerCpuLoadPercentage`, `telemetrySerializationTimeMs`, `telemetryPayloadBytes`, `canvasFps`, `uiMainThreadBlockedTimeMs`, `workerMessageQueueLagMs` | Advanced real-time simulation health diagnostic instrument. Tracks Web Worker CPU load, execution jitter, time drift, frame skips, serialization latency, and telemetry packet bandwidth. |
| `openhw-diode`<br>`openhw-npn-transistor` | `[]` (Stateless) | Purely electrical components; nodal voltages/currents are tracked via universal Nodal Analysis telemetry rather than explicit component state. |
| `openhw-breadboard`<br>`openhw-breadboard-half`<br>`openhw-breadboard-mini` | `[]` (Stateless) | Passive wiring distribution boards; electrical connectivity is managed by the simulation netlist topology. |
