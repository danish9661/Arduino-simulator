
class MockComponent {
    id: string;
    type: string;
    state: any = {};
    manifest: any;
    pins: Map<string, number> = new Map();

    constructor(id: string, manifest: any) {
        this.id = id;
        this.manifest = manifest;
    }

    getPinVoltage(pin: string) {
        return this.pins.get(pin) || 0;
    }

    setState(s: any) {
        this.state = { ...this.state, ...s };
    }
}

// Manually copying enough of BaseComponent/LEDLogic to test
class LEDLogicTest {
    id = "led1";
    state: any = { illuminated: false, burnedOut: false, vHistory: [] };
    voltageDrop = 1.8;
    pins: Map<string, number> = new Map();

    getPinVoltage(pin: string) {
        return this.pins.get(pin) || 0;
    }

    update() {
        const vA = this.getPinVoltage('A');
        const vK = this.getPinVoltage('K');
        const voltageDiff = vA - vK;

        console.log(`Checking LED: A=${vA}V, K=${vK}V, Diff=${voltageDiff}V`);

        if (voltageDiff >= 1.5) {
            console.log("  -> Illuminated!");
            this.state.illuminated = true;
        } else {
            console.log("  -> OFF");
            this.state.illuminated = false;
        }
    }
}

const led = new LEDLogicTest();

console.log("Test 1: Forward Bias (Correct)");
led.pins.set('A', 5);
led.pins.set('K', 0);
led.update();

console.log("\nTest 2: Reverse Bias (Incorrect)");
led.pins.set('A', 0);
led.pins.set('K', 5);
led.update();

console.log("\nTest 3: Reverse Bias (Small)");
led.pins.set('A', 2);
led.pins.set('K', 5);
led.update();
