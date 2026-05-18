---
title: Hardware Flashing (Web Serial)
description: Documentation on how the browser interfaces directly with physical microcontrollers.
outline: deep
---

# Hardware Flashing & Serial Monitor

## The Web Serial Bridge (`webSerialHardware.js`)
OpenHW Studio uses the browser's `navigator.serial` API to talk directly to physical boards.

* **Vendor Filtering:** The `DEFAULT_SERIAL_USB_FILTERS` array isolates relevant microcontrollers by filtering USB Vendor IDs (e.g., Arduino `0x2341`, Espressif `0x303A`, Raspberry Pi `0x2E8A`).
* **Stream Management:** Implements read/write loops using `TextEncoder` and `TextDecoder` streams to pipe data into the frontend `SimulationConsole`.

## Firmware Flashing (`useHardwareFlashing.js`)
When a user wants to push their code to a physical board:
1. The frontend hits the Compiler Backend to get the compiled Hex/UF2 binary.
2. The `flashFirmware` hook takes over, opening the serial port at the correct `hardwareBaudRate`.
3. It applies the necessary `hardwareResetMethod` (e.g., toggling DTR/RTS for ESP32/Arduino) to push the board into bootloader mode before streaming the binary.