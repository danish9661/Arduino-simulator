#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET   -1
#define OLED_ADDR    0x3C

#if defined(ARDUINO_ARCH_RP2040)
static const int I2C_SDA_PIN = 4;
static const int I2C_SCL_PIN = 5;
#endif

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void drawFrame(int x) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("OpenHW OLED Demo");
  display.println("UNO + Pico compatible");

  display.drawRect(0, 18, 128, 46, SSD1306_WHITE);
  display.fillCircle(x, 41, 6, SSD1306_WHITE);

  display.setCursor(0, 54);
  display.print("x=");
  display.print(x);

  display.display();
}

void setup() {
  Serial.begin(115200);

#if defined(ARDUINO_ARCH_RP2040)
  Wire.setSDA(I2C_SDA_PIN);
  Wire.setSCL(I2C_SCL_PIN);
#endif
  Wire.begin();

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    while (true) {
      delay(1000);
    }
  }

  display.clearDisplay();
  display.display();
}

void loop() {
  static int x = 8;
  static int dir = 1;

  drawFrame(x);

  x += dir;
  if (x >= 120) dir = -1;
  if (x <= 8) dir = 1;

  delay(25);
}
