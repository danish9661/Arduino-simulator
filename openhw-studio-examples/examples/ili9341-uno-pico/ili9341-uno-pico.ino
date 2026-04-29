#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#if defined(ARDUINO_ARCH_RP2040)
static const int TFT_CS  = 17;
static const int TFT_DC  = 20;
static const int TFT_RST = 21;
static const int TFT_SCK = 18;
static const int TFT_MOSI = 19;
static const int TFT_MISO = 16;
#else
static const int TFT_CS  = 10;
static const int TFT_DC  = 9;
static const int TFT_RST = 8;
#endif

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

void drawStaticFrame() {
  tft.fillScreen(ILI9341_NAVY);
  tft.setCursor(8, 8);
  tft.setTextColor(ILI9341_CYAN);
  tft.setTextSize(2);
  tft.println("OpenHW TFT Demo");

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(1);
  tft.setCursor(8, 34);
#if defined(ARDUINO_ARCH_RP2040)
  tft.println("Board: RP2040 Pico");
#else
  tft.println("Board: Arduino Uno");
#endif

  tft.drawRect(8, 52, 224, 20, ILI9341_WHITE);
  tft.drawLine(20, 190, 220, 190, ILI9341_MAGENTA);
}

void drawDashboard(int frame) {
  static int prevX = -1;

  int bar = frame % 220;
  tft.fillRect(10, 54, 220, 16, ILI9341_BLACK);
  tft.fillRect(10, 54, bar, 16, ILI9341_GREEN);

  int x = 20 + (frame % 180);
  if (prevX >= 0) {
    tft.fillCircle(prevX, 120, 14, ILI9341_NAVY);
  }
  tft.fillCircle(x, 120, 14, ILI9341_YELLOW);
  prevX = x;

  tft.fillRect(20, 140, 200, 50, ILI9341_NAVY);
  tft.drawLine(20, 190, 220, 190, ILI9341_MAGENTA);
  tft.drawLine(20, 190, 20 + (frame % 200), 140, ILI9341_RED);

  tft.fillRect(8, 214, 224, 12, ILI9341_NAVY);
  tft.setCursor(8, 214);
  tft.setTextColor(ILI9341_ORANGE);
  tft.print("frame=");
  tft.print(frame);
}

void setup() {
  Serial.begin(115200);

#if defined(ARDUINO_ARCH_RP2040)
  SPI.setRX(TFT_MISO);
  SPI.setTX(TFT_MOSI);
  SPI.setSCK(TFT_SCK);
#endif
  SPI.begin();

  tft.begin();
  tft.setRotation(1);
  drawStaticFrame();
}

void loop() {
  static int frame = 0;
  drawDashboard(frame);
  frame += 4;
  delay(60);
}
