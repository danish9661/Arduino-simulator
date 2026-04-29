# UART LED link examples

These examples send single-byte commands over UART:
- `1` -> turn receiver LED ON
- `0` -> turn receiver LED OFF

## 1) UNO -> UNO (SoftwareSerial)

Use:
- `uno2uno_sender_soft.ino` on board A
- `uno2uno_receiver_soft.ino` on board B

Wiring:
- board A `D10` (soft TX) -> board B `D11` (soft RX)
- board A `GND` -> board B `GND`

## 2) Pico -> Pico (SoftwareSerial)

Use:
- `pico2pico_sender_soft.ino` on board A
- `pico2pico_receiver_soft.ino` on board B

Wiring:
- board A `GP10` (soft TX) -> board B `GP11` (soft RX)
- board A `GND` -> board B `GND`

## 3) UNO -> Pico (Hardware UART)

Use:
- `uno2pico_uno_sender_hw.ino` on UNO sender
- `uno2pico_pico_receiver_hw.ino` on Pico receiver

Wiring:
- UNO `D1` (`TX`) -> Pico `GP1` (`UART0 RX`)
- UNO `GND` -> Pico `GND`

Notes:
- All sketches use 9600 baud.
- Receiver LED is `LED_BUILTIN` on each board.
- For reverse-direction tests, swap sender/receiver roles and cross TX->RX accordingly.
