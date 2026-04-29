import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const prefix = 'openhw-studio-cli';
const runCli = 'npm --prefix ' + prefix + ' run cli -- ';

function run(cmd) {
  console.log('Running:', cmd);
  try { 
    const out = execSync(cmd, { stdio: 'pipe' });
    return out.toString(); 
  } catch (e) { 
    console.error('Failed:', cmd); 
    if (e.stdout) console.error('STDOUT:', e.stdout.toString());
    if (e.stderr) console.error('STDERR:', e.stderr.toString());
    process.exit(1); 
  }
}

const testDir = 'temp/tests';
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

function setupPicoPico() {
  const proj = path.join(testDir, 'pico_pico_uart.json');
  if (fs.existsSync(proj)) fs.unlinkSync(proj);

  console.log('--- Setting up Pico-Pico UART Test ---');
  run(runCli + ` project init ${proj} --name "PICO-PICO-UART" --board pi_pico`);
  run(runCli + ` project add-component ${proj} --type wokwi-raspberry-pi-pico --id board2`);
  run(runCli + ` project add-component ${proj} --type wokwi-pushbutton --id btn1`);
  run(runCli + ` project add-component ${proj} --type wokwi-led --id led1 --attrs-json "{\\"color\\": \\"red\\"}"`);

  // UART connections
  run(runCli + ` project connect ${proj} --from board1:GP0 --to board2:GP1`); // TX1 -> RX2
  run(runCli + ` project connect ${proj} --from board1:GP1 --to board2:GP0`); // RX1 -> TX2 (not strictly needed for this test but good practice)

  // Button connection: GP2 to btn1:2, btn1:1 to GND
  // Note: Wokwi button pins are 1, 2.
  run(runCli + ` project connect ${proj} --from board1:GP2 --to btn1:2`);
  run(runCli + ` project connect ${proj} --from board1:GND --to btn1:1`);

  // LED connection: GP3 to led1:A, led1:K to GND
  run(runCli + ` project connect ${proj} --from board2:GP3 --to led1:A`);
  run(runCli + ` project connect ${proj} --from board2:GND --to led1:K`);

  // Firmware
  const code1 = `
void setup() {
  Serial1.begin(9600);
  pinMode(2, INPUT_PULLUP);
}
void loop() {
  if (digitalRead(2) == LOW) {
    Serial1.write('H');
    delay(200);
  }
}
`;
  const code2 = `
void setup() {
  Serial1.begin(9600);
  pinMode(3, OUTPUT);
}
void loop() {
  if (Serial1.available()) {
    char c = Serial1.read();
    if (c == 'H') {
      digitalWrite(3, HIGH);
    }
  }
}
`;
  fs.writeFileSync(path.join(testDir, 'pico1.ino'), code1);
  fs.writeFileSync(path.join(testDir, 'pico2.ino'), code2);

  run(runCli + ` project set-code ${proj} --board-id board1 --file project/board1/board1.ino --code-file ${path.join(testDir, 'pico1.ino')}`);
  run(runCli + ` project set-code ${proj} --board-id board2 --file project/board2/board2.ino --code-file ${path.join(testDir, 'pico2.ino')}`);

  return proj;
}

function setupUnoPico() {
  const proj = path.join(testDir, 'uno_pico_uart.json');
  if (fs.existsSync(proj)) fs.unlinkSync(proj);

  console.log('--- Setting up Uno-Pico UART Test ---');
  run(runCli + ` project init ${proj} --name "UNO-PICO-UART" --board arduino_uno`);
  run(runCli + ` project add-component ${proj} --type wokwi-raspberry-pi-pico --id board2`);
  run(runCli + ` project add-component ${proj} --type wokwi-pushbutton --id btn1`);
  run(runCli + ` project add-component ${proj} --type wokwi-led --id led1 --attrs-json "{\\"color\\": \\"green\\"}"`);

  // UART connections: Uno D1 (TX) -> Pico GP1 (RX)
  run(runCli + ` project connect ${proj} --from board1:1 --to board2:GP1`);
  run(runCli + ` project connect ${proj} --from board1:0 --to board2:GP0`);

  // Button connection: Uno D2 to btn1:2, btn1:1 to GND
  run(runCli + ` project connect ${proj} --from board1:2 --to btn1:2`);
  run(runCli + ` project connect ${proj} --from board1:gnd_1 --to btn1:1`);

  // LED connection: Pico GP3 to led1:A, led1:K to GND
  run(runCli + ` project connect ${proj} --from board2:GP3 --to led1:A`);
  run(runCli + ` project connect ${proj} --from board2:GND --to led1:K`);

  // Firmware
  const codeUno = `
void setup() {
  Serial.begin(9600);
  pinMode(2, INPUT_PULLUP);
}
void loop() {
  if (digitalRead(2) == LOW) {
    Serial.write('H');
    delay(200);
  }
}
`;
  const codePico = `
void setup() {
  Serial1.begin(9600);
  pinMode(3, OUTPUT);
}
void loop() {
  if (Serial1.available()) {
    char c = Serial1.read();
    if (c == 'H') {
      digitalWrite(3, HIGH);
    }
  }
}
`;
  fs.writeFileSync(path.join(testDir, 'uno.ino'), codeUno);
  fs.writeFileSync(path.join(testDir, 'pico_rx.ino'), codePico);

  run(runCli + ` project set-code ${proj} --board-id board1 --file project/board1/board1.ino --code-file ${path.join(testDir, 'uno.ino')}`);
  run(runCli + ` project set-code ${proj} --board-id board2 --file project/board2/board2.ino --code-file ${path.join(testDir, 'pico_rx.ino')}`);

  return proj;
}

function verify(proj) {
  console.log(`--- Verifying ${proj} ---`);
  
  // Step 1: Verify LED is OFF initially
  console.log('Checking initial state (should be OFF)...');
  const initialResult = run(runCli + ` sim inspect ${proj} --all-boards --duration-ms 500 --component-id led1`);
  const initialData = JSON.parse(extractJson(initialResult));
  if (initialData.ok && initialData.component && initialData.component.snapshotState) {
    const isOff = !(initialData.component.snapshotState.illuminated === true || initialData.component.snapshotState.brightness > 0);
    if (!isOff) {
      console.error('FAILURE: LED is ON at startup!');
      process.exit(1);
    }
    console.log('SUCCESS: LED is OFF at startup.');
  }

  // Step 2: Inject press event and verify LED turns ON
  console.log('Checking state after button press (should be ON)...');
  const result = run(runCli + ` sim inspect ${proj} --all-boards --duration-ms 3000 --event-component-id btn1 --event press --at-ms 1000 --component-id led1`);
  const data = JSON.parse(extractJson(result));
  
  if (data.ok && data.component && data.component.snapshotState) {
    const state = data.component.snapshotState;
    console.log(`LED State:`, JSON.stringify(state));
    if (state.value === true || state.brightness > 0 || state.active === true || state.level > 0 || state.illuminated === true) {
      console.log(`SUCCESS: LED on ${proj} turned ON.`);
    } else {
      console.log(`FAILURE: LED on ${proj} did not turn ON.`);
      process.exit(1);
    }
  } else {
    console.error('Failed to get LED state from inspect.');
    process.exit(1);
  }
}

function extractJson(result) {
  const jsonStart = result.indexOf('{');
  const jsonEnd = result.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    console.error('No JSON found in output:', result);
    process.exit(1);
  }
  return result.substring(jsonStart, jsonEnd + 1);
}

const picoProj = setupPicoPico();
verify(picoProj);

const unoProj = setupUnoPico();
verify(unoProj);

console.log('\nALL TESTS PASSED SUCCESSFULLY!');
