import { execSync } from 'child_process';
import fs from 'fs';

function run(cmd) {
  console.log('Running:', cmd);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error('Failed:', cmd);
    process.exit(1);
  }
}

const prefix = 'openhw-studio-cli';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

fs.mkdirSync('temp/tests', { recursive: true });

function setupUnoUno() {
  console.log('--- Setting up UNO-UNO ---');
  const proj = 'temp/tests/uno_uno.json';
  if (fs.existsSync(proj)) fs.unlinkSync(proj);
  
  run(runCli + ' project init ' + proj + ' --name "UNO-UNO" --board arduino_uno');
  run(runCli + ' project add-component ' + proj + ' --type openhw-arduino-uno --id board2');
  run(runCli + ' project add-component ' + proj + ' --type openhw-pushbutton --id btn');
  run(runCli + ' project add-component ' + proj + ' --type openhw-led --id led');
  
  // Wokwi pushbutton pins are '1.l', '2.l' or '1' etc. If '1.l' is not found, we use '1' and '2'
  run(runCli + ' project connect ' + proj + ' --from btn:1 --to board1:2');
  run(runCli + ' project connect ' + proj + ' --from btn:2 --to board1:GND.1');
  run(runCli + ' project connect ' + proj + ' --from led:A --to board2:13');
  run(runCli + ' project connect ' + proj + ' --from led:C --to board2:GND.1');
  
  run(runCli + ' project connect ' + proj + ' --from board1:1 --to board2:0');
  run(runCli + ' project connect ' + proj + ' --from board1:0 --to board2:1');
  
  fs.writeFileSync('temp/tests/code1.ino', 'int btnPin = 2; void setup() { Serial.begin(9600); pinMode(btnPin, INPUT_PULLUP); } void loop() { if (digitalRead(btnPin) == LOW) { Serial.write(65); delay(200); } }');
  fs.writeFileSync('temp/tests/code2.ino', 'int ledPin = 13; void setup() { Serial.begin(9600); pinMode(ledPin, OUTPUT); digitalWrite(ledPin, LOW); } void loop() { if (Serial.available()) { char c = Serial.read(); if (c == 65) { digitalWrite(ledPin, HIGH); delay(200); digitalWrite(ledPin, LOW); } } }');
  
  run(runCli + ' project set-code ' + proj + ' --board-id board1 --file temp/tests/code1.ino');
  run(runCli + ' project set-code ' + proj + ' --board-id board2 --file temp/tests/code2.ino');
  
  // To press the button, we might not be able to interact with it programmatically unless there's a trace or input file.
  // Instead of waiting for button, let's just make board1 send the UART signal unconditionally for the test.
  fs.writeFileSync('temp/tests/code1.ino', 'void setup() { Serial.begin(9600); } void loop() { Serial.write(65); delay(200); }');
  run(runCli + ' project set-code ' + proj + ' --board-id board1 --file temp/tests/code1.ino');

  run(runCli + ' sim trace ' + proj + ' --all-boards --duration-ms 3000 --event-types serial --include-serial-text --output temp/tests/uno_trace.json');
}

setupUnoUno();
