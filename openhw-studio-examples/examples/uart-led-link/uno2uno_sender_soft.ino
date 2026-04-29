#include <SoftwareSerial.h>

SoftwareSerial link(11, 10); // RX, TX

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  link.begin(9600);
}

void loop() {
  link.write('1');
  digitalWrite(LED_BUILTIN, HIGH);
  delay(700);

  link.write('0');
  digitalWrite(LED_BUILTIN, LOW);
  delay(700);
}
