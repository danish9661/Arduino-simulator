import { CPU, AVRIOPort, portDConfig, PinState } from 'avr8js';

const program = new Uint16Array(32768);
const cpu = new CPU(program, 0x2200);
const portD = new AVRIOPort(cpu, portDConfig);

// Set pin 5 to INPUT_PULLUP
// In ATmega328P, PORTD is at I/O address 0x0b (data address 0x2b)
// DDRD is at I/O address 0x0a (data address 0x2a)

// DDRD bit 5 = 0 (Input)
// PORTD bit 5 = 1 (Pullup enabled)

// Let's write directly to DDRD and PORTD using cpu.writeData
cpu.writeData(0x2a, 0x00); // DDRD = 0
cpu.writeData(0x2b, 1 << 5); // PORTD = 1 << 5

console.log('PinState of pin 5:', portD.pinState(5));
console.log('PinState enum mapping:');
console.log('  PinState.Input:', PinState.Input);
console.log('  PinState.InputPullUp:', PinState.InputPullUp);
console.log('  PinState.Low:', PinState.Low);
console.log('  PinState.High:', PinState.High);
