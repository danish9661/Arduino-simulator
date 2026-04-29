#include <Arduino.h>

volatile uint32_t gCtr = 0;

void setup() {
  pinMode(15, OUTPUT);
  pinMode(16, OUTPUT);
  Serial1.begin(115200);
  Serial1.println("RP2040_NATIVE_BOOT_OK");
}

void loop() {
  gCtr++;
  bool high = (gCtr & 0x2000u) != 0;

  digitalWrite(15, high ? HIGH : LOW);
  digitalWrite(16, high ? LOW : HIGH);

  if ((gCtr & 0x3fffu) == 0) {
    Serial1.println(high ? "RP2040_NATIVE_H" : "RP2040_NATIVE_L");
  }
}
