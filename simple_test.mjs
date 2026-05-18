import fs from 'fs';
import { execSync } from 'child_process';

const prefix = 'openhw-studio-cli';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

function run(cmd) {
  console.log('Running:', cmd);
  try { execSync(cmd, { stdio: 'inherit' }); } catch (e) { console.error('Failed:', cmd); process.exit(1); }
}

const proj = 'temp/tests/uno_uno.json';
if (fs.existsSync(proj)) fs.unlinkSync(proj);

run(runCli + ' project init ' + proj + ' --name "UNO-UNO" --board arduino_uno');
run(runCli + ' project add-component ' + proj + ' --type openhw-arduino-uno --id board2');
run(runCli + ' project connect ' + proj + ' --from board1:1 --to board2:0');
run(runCli + ' project connect ' + proj + ' --from board1:0 --to board2:1');

fs.writeFileSync('temp/tests/code1.ino', 'void setup() { Serial.begin(9600); } void loop() { Serial.write(65); delay(200); }');
fs.writeFileSync('temp/tests/code2.ino', 'int ledPin = 13; void setup() { Serial.begin(9600); pinMode(ledPin, OUTPUT); digitalWrite(ledPin, LOW); } void loop() { if (Serial.available()) { char c = Serial.read(); if (c == 65) { digitalWrite(ledPin, HIGH); delay(200); digitalWrite(ledPin, LOW); } } }');

run(runCli + ' project set-code ' + proj + ' --board-id board1 --code-file temp/tests/code1.ino');
run(runCli + ' project set-code ' + proj + ' --board-id board2 --code-file temp/tests/code2.ino');

run(runCli + ' sim trace ' + proj + ' --all-boards --duration-ms 3000 --event-types serial,state --include-serial-text --output temp/tests/uno_trace.json');
