#!/usr/bin/env node
import fs from 'fs';
import { execSync } from 'child_process';
import fetch from 'node-fetch';

const prefix = 'openhw-studio-cli';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

// Create project
const proj = 'temp/tests/pico_lcd_debug.json';
if (fs.existsSync(proj)) fs.unlinkSync(proj);

console.log('[TEST] Creating Pico + LCD2004 project...');
execSync(runCli + ' project init ' + proj + ' --name "Pico LCD Debug" --board wokwi-raspberry-pi-pico', { stdio: 'inherit' });
execSync(runCli + ' project add-component ' + proj + ' --type wokwi-lcd-20x4 --id lcd1', { stdio: 'inherit' });
execSync(runCli + ' project connect ' + proj + ' --from board1:4 --to lcd1:SDA', { stdio: 'inherit' });
execSync(runCli + ' project connect ' + proj + ' --from board1:5 --to lcd1:SCL', { stdio: 'inherit' });

// Create test code
const code = `#include <Wire.h>
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
  lcd.print("Test LCD2004");
}

void loop() {
  static unsigned long counter = 0;
  const unsigned long ms = millis();
  lcd.setCursor(0, 1);
  lcd.print("Count: ");
  lcd.setCursor(8, 1);
  lcd.print(counter++);
  delay(500);
}`;

fs.writeFileSync('temp/tests/lcd_code.ino', code);
console.log('[TEST] Setting code for Pico...');
execSync(runCli + ' project set-code ' + proj + ' --board-id board1 --code-file temp/tests/lcd_code.ino', { stdio: 'inherit' });

// Grade the project - using the backend API directly
console.log('[TEST] Grading project...');

const projectData = JSON.parse(fs.readFileSync(proj, 'utf8'));

try {
  // Start backend grading if available
  const response = await fetch('http://127.0.0.1:5001/api/grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teacher: projectData,
      student: projectData,
    })
  });

  if (!response.ok) {
    console.error('[ERROR] Grading API returned:', response.status);
    const text = await response.text();
    console.error('[ERROR] Response:', text);
    process.exit(1);
  }

  const result = await response.json();
  console.log('[TEST] Grading complete. Score:', result.grading_report?.score || 'unknown');
  console.log('[TEST] Events captured:', result.grading_report?.student_telemetry?.length || 0);
  console.log('[TEST] Full result written to temp/tests/lcd_debug_result.json');
  fs.writeFileSync('temp/tests/lcd_debug_result.json', JSON.stringify(result, null, 2));
} catch (e) {
  console.error('[ERROR] Grading failed:', e.message);
  console.log('[INFO] Make sure backend is running (http://127.0.0.1:5001)');
  process.exit(1);
}
