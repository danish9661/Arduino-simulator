<<<<<<< HEAD
# OpenHW Examples

Reference circuits and starter projects for OpenHW Studio.

## What Is Included

- `examples/`: ready-to-run circuit projects grouped by component use case.
- `custom-components/`: sample structures for custom component integrations.

Notable example folders:
- `examples/sd-card-spi/`: SPI command-level probe for `wokwi-sd-card` (`sd_probe.ino` + `main.py`).

## Usage

1. Start backend and frontend services.
2. Open simulator and load an example project.
3. For Pico examples, keep `.ino` enabled for Arduino compile mode or disable it to run `main.py` in MicroPython mode.

## Notes

- Example assets are served through backend `/examples` static route.
- Backend should have both `arduino:avr` and `rp2040:rp2040` cores installed for full board compatibility.
=======
﻿# openhw-studio-examples

This repository contains sample projects for OpenHW Studio.
Each example may include:
- `diagram.json` for circuit topology
- `sketch.ino` for demo code
- `guide.json` for guide-page context

## Available examples
- `examples/led-blink`
- `examples/rgb-led`
>>>>>>> origin/main
