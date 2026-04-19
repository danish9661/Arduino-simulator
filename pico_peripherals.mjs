import fs from 'fs';
import { execSync } from 'child_process';

const prefix = 'openhw-studio-cli-danish';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

function run(cmd) {
  try { execSync(cmd, { stdio: 'inherit' }); } catch (e) { console.error('Failed:', cmd); process.exit(1); }
}

const projNeo = 'temp/tests/pico_neo.json';
if (fs.existsSync(projNeo)) fs.unlinkSync(projNeo);
run(runCli + ' project init ' + projNeo + ' --name "PICO-NEO" --board pi_pico');
run(runCli + ' project add-component ' + projNeo + ' --type wokwi-neopixel --id ring');
run(runCli + ' project connect ' + projNeo + ' --from board1:GP0 --to ring:DIN');
fs.writeFileSync('temp/tests/neo.ino', '#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel pixels(16, 0, NEO_GRB + NEO_KHZ800);\nvoid setup() { pixels.begin(); }\nvoid loop() { pixels.setPixelColor(0, pixels.Color(0, 150, 0)); pixels.show(); delay(500); }');
run(runCli + ' project set-code ' + projNeo + ' --board-id board1 --code-file temp/tests/neo.ino');
run(runCli + ' sim trace ' + projNeo + ' --all-boards --duration-ms 2000 --event-types state --output temp/tests/pico_neo_trace.json');

const projSrv = 'temp/tests/pico_srv.json';
if (fs.existsSync(projSrv)) fs.unlinkSync(projSrv);
run(runCli + ' project init ' + projSrv + ' --name "PICO-SRV" --board pi_pico');
run(runCli + ' project add-component ' + projSrv + ' --type wokwi-servo --id servo');
run(runCli + ' project add-component ' + projSrv + ' --type wokwi-potentiometer --id pot');
run(runCli + ' project connect ' + projSrv + ' --from board1:GP15 --to servo:PWM');
run(runCli + ' project connect ' + projSrv + ' --from board1:GP26 --to pot:SIG');
fs.writeFileSync('temp/tests/srv.ino', '#include <Servo.h>\nServo myservo;\nvoid setup() { myservo.attach(15); }\nvoid loop() { int val = analogRead(26); val = map(val, 0, 1023, 0, 180); myservo.write(val); delay(15); }');
run(runCli + ' project set-code ' + projSrv + ' --board-id board1 --code-file temp/tests/srv.ino');
run(runCli + ' sim trace ' + projSrv + ' --all-boards --duration-ms 2000 --event-types state --output temp/tests/pico_srv_trace.json');
