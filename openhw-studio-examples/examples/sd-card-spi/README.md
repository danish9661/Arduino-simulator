# SD Card SPI Demo

This example validates the simulated `wokwi-sd-card` component with real SPI traffic.

## Included files

- `sd_probe.ino`: Arduino Uno SPI probe for CMD0/CMD8/CMD55/ACMD41/CMD58/CMD17/CMD24
- `main.py`: MicroPython SPI probe for the same command sequence
- `connections.txt`: Recommended wiring

## Expected behavior

Both scripts print command responses and continuously emit a heartbeat line.
Look for:

- `*_CMD0_R1` and `*_CMD8_R1`
- `*_CMD17_R1` + `*_READ_TOKEN`
- `*_CMD24_R1` + `*_WRITE_TOKEN`
- `*_HEARTBEAT`
