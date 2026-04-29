void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  Serial.write('1');
  digitalWrite(LED_BUILTIN, HIGH);
  delay(700);

  Serial.write('0');
  digitalWrite(LED_BUILTIN, LOW);
  delay(700);
}
