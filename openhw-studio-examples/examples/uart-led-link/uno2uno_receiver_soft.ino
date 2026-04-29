#include <SoftwareSerial.h>

SoftwareSerial link(11, 10); // RX, TX

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  link.begin(9600);
}

void loop() {
  while (link.available() > 0) {
    const int cmd = link.read();
    if (cmd == '1') {
      digitalWrite(LED_BUILTIN, HIGH);
    } else if (cmd == '0') {
      digitalWrite(LED_BUILTIN, LOW);
    }
  }
}
