import fs from 'fs';
import { execSync } from 'child_process';

const prefix = 'openhw-studio-cli-danish';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

function run(cmd) {
  console.log('Running:', cmd);
  try { execSync(cmd, { stdio: 'inherit' }); } catch (e) { console.error('Failed:', cmd); process.exit(1); }
}

const proj = 'temp/tests/pico_pico.json';
if (fs.existsSync(proj)) fs.unlinkSync(proj);

run(runCli + ' project init ' + proj + ' --name "PICO-PICO" --board pi_pico');
run(runCli + ' project add-component ' + proj + ' --type wokwi-raspberry-pi-pico --id board2');

run(runCli + ' project connect ' + proj + ' --from board1:GP0 --to board2:GP1');
run(runCli + ' project connect ' + proj + ' --from board1:GP1 --to board2:GP0');

fs.writeFileSync('temp/tests/pico1.ino', 'void setup() { Serial1.begin(9600); } void loop() { Serial1.write(65); delay(200); }');
fs.writeFileSync('temp/tests/pico2.ino', 'void setup() { Serial1.begin(9600); pinMode(LED_BUILTIN, OUTPUT); digitalWrite(LED_BUILTIN, LOW); } void loop() { if (Serial1.available()) { char c = Serial1.read(); if (c == 65) { digitalWrite(LED_BUILTIN, HIGH); delay(200); digitalWrite(LED_BUILTIN, LOW); } } }');

run(runCli + ' project set-code ' + proj + ' --board-id board1 --code-file temp/tests/pico1.ino');
run(runCli + ' project set-code ' + proj + ' --board-id board2 --code-file temp/tests/pico2.ino');

run(runCli + ' sim trace ' + proj + ' --all-boards --duration-ms 3000 --event-types serial,state --include-serial-text --output temp/tests/pico_trace.json');
