void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  // UART0 defaults on GP0/GP1, but set explicitly for clarity.
  Serial1.setTX(0);
  Serial1.setRX(1);
  Serial1.begin(9600);
}

void loop() {
  while (Serial1.available() > 0) {
    const int cmd = Serial1.read();
    if (cmd == '1') {
      digitalWrite(LED_BUILTIN, HIGH);
    } else if (cmd == '0') {
      digitalWrite(LED_BUILTIN, LOW);
    }
  }
}
