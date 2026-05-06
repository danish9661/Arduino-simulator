
import { FullCircuitValidator } from '../openhw-studio-emulator/src/circuit-validation/engine.js';
import { validateComponentLimits, validateReversePolarity } from '../openhw-studio-emulator/src/circuit-validation/rules/realWorldRules.js';

// Scenario 1: Active-Low LED with no resistor (Forward Bias check)
const project1 = {
    components: [
        { id: 'uno1', type: 'wokwi-arduino-uno' },
        { id: 'led1', type: 'wokwi-led', pins: [{id: 'A'}, {id: 'K'}] }
    ],
    connections: [
        { from: 'led1.A', to: 'uno1.5V' },
        { from: 'led1.K', to: 'uno1.13' }
    ]
};

console.log("--- Running Scenario 1: 5V -> LED -> Pin 13 (No Resistor) ---");
const validator1 = new FullCircuitValidator(project1);
validateComponentLimits(validator1);
console.log("Errors:", JSON.stringify(validator1.errors, null, 2));

// Scenario 4: Reverse Polarity (Predictive)
// 5V -> LED.K. LED.A -> Pin 13
const project4 = {
    components: [
        { id: 'uno1', type: 'wokwi-arduino-uno' },
        { id: 'led1', type: 'wokwi-led', pins: [{id: 'A'}, {id: 'K'}] }
    ],
    connections: [
        { from: 'uno1.5V', to: 'led1.K' },
        { from: 'led1.A', to: 'uno1.13' }
    ]
};

console.log("\n--- Running Scenario 4: 5V -> LED.K, LED.A -> Pin 13 (Reverse Polarity) ---");
const validator4 = new FullCircuitValidator(project4);
validateReversePolarity(validator4);
console.log("Errors:", JSON.stringify(validator4.errors, null, 2));

// Scenario 5: Reverse Polarity (High Potential)
// 12V -> LED.K. LED.A -> GND
const project5 = {
    components: [
        { id: 'ext12v', type: 'wokwi-power-supply', attrs: { voltage: '12' } },
        { id: 'led1', type: 'wokwi-led', pins: [{id: 'A'}, {id: 'K'}] }
    ],
    connections: [
        { from: 'ext12v.VCC', to: 'led1.K' },
        { from: 'led1.A', to: 'ext12v.GND' }
    ]
};

console.log("\n--- Running Scenario 5: 12V -> LED.K, LED.A -> GND (Reverse Breakdown) ---");
const validator5 = new FullCircuitValidator(project5);
validateReversePolarity(validator5);
console.log("Errors:", JSON.stringify(validator5.errors, null, 2));
