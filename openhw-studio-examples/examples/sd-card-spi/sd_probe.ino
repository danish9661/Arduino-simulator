#include <SPI.h>

static const uint8_t SD_CS_PIN = 10;

uint8_t sdWaitResponse() {
  for (uint16_t i = 0; i < 300; i++) {
    uint8_t r = SPI.transfer(0xFF);
    if ((r & 0x80) == 0) {
      return r;
    }
  }
  return 0xFF;
}

void sdSelect() {
  digitalWrite(SD_CS_PIN, LOW);
}

void sdRelease() {
  digitalWrite(SD_CS_PIN, HIGH);
  SPI.transfer(0xFF);
}

uint8_t sdCommand(uint8_t cmd, uint32_t arg, uint8_t crc) {
  sdSelect();
  SPI.transfer(0x40 | (cmd & 0x3F));
  SPI.transfer((arg >> 24) & 0xFF);
  SPI.transfer((arg >> 16) & 0xFF);
  SPI.transfer((arg >> 8) & 0xFF);
  SPI.transfer(arg & 0xFF);
  SPI.transfer(crc);
  return sdWaitResponse();
}

bool sdReadBlock(uint32_t blockIndex, uint8_t *out512) {
  const uint8_t r1 = sdCommand(17, blockIndex, 0x01);
  Serial.print("SD_CMD17_R1=");
  Serial.println(r1, HEX);
  if (r1 != 0x00) {
    sdRelease();
    return false;
  }

  uint8_t token = 0xFF;
  for (uint16_t i = 0; i < 800; i++) {
    token = SPI.transfer(0xFF);
    if (token != 0xFF) break;
  }

  Serial.print("SD_READ_TOKEN=");
  Serial.println(token, HEX);
  if (token != 0xFE) {
    sdRelease();
    return false;
  }

  for (uint16_t i = 0; i < 512; i++) {
    out512[i] = SPI.transfer(0xFF);
  }

  SPI.transfer(0xFF);
  SPI.transfer(0xFF);
  sdRelease();
  return true;
}

bool sdWriteBlock(uint32_t blockIndex, const uint8_t *payload512) {
  const uint8_t r1 = sdCommand(24, blockIndex, 0x01);
  Serial.print("SD_CMD24_R1=");
  Serial.println(r1, HEX);
  if (r1 != 0x00) {
    sdRelease();
    return false;
  }

  SPI.transfer(0xFF);
  SPI.transfer(0xFE);
  for (uint16_t i = 0; i < 512; i++) {
    SPI.transfer(payload512[i]);
  }
  SPI.transfer(0xFF);
  SPI.transfer(0xFF);

  const uint8_t dataResponse = SPI.transfer(0xFF) & 0x1F;
  Serial.print("SD_WRITE_TOKEN=");
  Serial.println(dataResponse, HEX);

  for (uint16_t i = 0; i < 400; i++) {
    if (SPI.transfer(0xFF) == 0xFF) break;
  }

  sdRelease();
  return dataResponse == 0x05;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("SD_SPI_DEMO_BOOT");

  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));

  // Clock out >74 cycles with CS high before first command.
  for (uint8_t i = 0; i < 12; i++) {
    SPI.transfer(0xFF);
  }

  uint8_t r0 = sdCommand(0, 0, 0x95);
  Serial.print("SD_CMD0_R1=");
  Serial.println(r0, HEX);
  sdRelease();

  uint8_t r8 = sdCommand(8, 0x000001AAUL, 0x87);
  Serial.print("SD_CMD8_R1=");
  Serial.println(r8, HEX);
  // Consume trailing R7 bytes if present.
  for (uint8_t i = 0; i < 4; i++) {
    SPI.transfer(0xFF);
  }
  sdRelease();

  uint8_t r55 = sdCommand(55, 0, 0x01);
  Serial.print("SD_CMD55_R1=");
  Serial.println(r55, HEX);
  sdRelease();

  uint8_t r41 = sdCommand(41, 0x40000000UL, 0x01);
  Serial.print("SD_ACMD41_R1=");
  Serial.println(r41, HEX);
  sdRelease();

  uint8_t r58 = sdCommand(58, 0, 0x01);
  Serial.print("SD_CMD58_R1=");
  Serial.println(r58, HEX);
  for (uint8_t i = 0; i < 4; i++) {
    SPI.transfer(0xFF);
  }
  sdRelease();

  uint8_t block[512];
  if (sdReadBlock(0, block)) {
    Serial.print("SD_READ_B0=");
    Serial.print(block[0], HEX);
    Serial.print(",");
    Serial.print(block[1], HEX);
    Serial.print(",");
    Serial.println(block[2], HEX);
  }

  for (uint16_t i = 0; i < 512; i++) {
    block[i] = static_cast<uint8_t>(i & 0xFF);
  }
  bool writeOk = sdWriteBlock(2, block);
  Serial.print("SD_WRITE_B2=");
  Serial.println(writeOk ? "OK" : "FAIL");

  SPI.endTransaction();
}

void loop() {
  static uint32_t lastBeat = 0;
  uint32_t now = millis();
  if (now - lastBeat >= 2000) {
    lastBeat = now;
    Serial.println("SD_SPI_DEMO_HEARTBEAT");
  }
}
