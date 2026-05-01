import { analyzeCodeHardwareSync } from '../../openhw-studio-emulator/src/circuit-validation/sync-analyzer.js';

const mockProject = {
  code: `
void setup() {
  pinMode(12, OUTPUT);
}

void loop() {
  digitalWrite(12, HIGH);
  delay(500);
  digitalWrite(12, LOW);
  delay(500);
}
`,
  components: [
    { id: 'uno1', type: 'wokwi-arduino-uno' }
  ],
  connections: [], // Nothing connected
  board: 'uno1'
};

const result = analyzeCodeHardwareSync(mockProject);
console.log('Validation Result:', JSON.stringify(result, null, 2));
