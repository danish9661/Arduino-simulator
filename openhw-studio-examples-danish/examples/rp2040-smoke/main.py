from machine import Pin
import time

led = Pin(15, Pin.OUT)

print("RP2040_MICROPY_BOOT_OK")

for i in range(40):
    led.value(i % 2)
    print("RP2040_MICROPY_TICK", i, "led", i % 2)
    time.sleep_ms(120)

print("RP2040_MICROPY_DONE")
