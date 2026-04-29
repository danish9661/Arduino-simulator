#include <Wire.h>
#include <LiquidCrystal_I2C.h>

#if defined(ARDUINO_ARCH_RP2040)
static const int I2C_SDA_PIN = 4;
static const int I2C_SCL_PIN = 5;
#endif

LiquidCrystal_I2C lcd(0x27, 20, 4);

void setup() {
  Serial.begin(115200);

#if defined(ARDUINO_ARCH_RP2040)
  Wire.setSDA(I2C_SDA_PIN);
  Wire.setSCL(I2C_SCL_PIN);
#endif
  Wire.begin();

  lcd.init();
  lcd.backlight();

  lcd.setCursor(0, 0);
  lcd.print("OpenHW LCD2004 Demo");

#if defined(ARDUINO_ARCH_RP2040)
  lcd.setCursor(0, 1);
  lcd.print("Board: RP2040 Pico");
#else
  lcd.setCursor(0, 1);
  lcd.print("Board: Arduino Uno");
#endif
}

void loop() {
  static unsigned long counter = 0;
  const unsigned long ms = millis();

  lcd.setCursor(0, 2);
  lcd.print("Millis:            ");
  lcd.setCursor(8, 2);
  lcd.print(ms);

  lcd.setCursor(0, 3);
  lcd.print("Count :            ");
  lcd.setCursor(8, 3);
  lcd.print(counter++);

  delay(250);
}
