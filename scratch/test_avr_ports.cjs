const { CPU, AVRIOPort, portDConfig, PinState } = require('avr8js');

const program = new Uint16Array(32768);
const cpu = new CPU(program, 0x2200);
const portD = new AVRIOPort(cpu, portDConfig);

// DDRD bit 5 = 0 (Input)
// PORTD bit 5 = 1 (Pullup enabled)
cpu.writeData(0x2a, 0x00); // DDRD = 0
cpu.writeData(0x2b, 1 << 5); // PORTD = 1 << 5

console.log('PinState of pin 5:', portD.pinState(5));
console.log('PinState enum mapping:');
console.log('  PinState.Input:', PinState.Input);
console.log('  PinState.InputPullUp:', PinState.InputPullUp);
console.log('  PinState.Low:', PinState.Low);
console.log('  PinState.High:', PinState.High);
