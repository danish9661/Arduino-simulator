import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';

function samePin(pinId: string, expected: string) {
    return String(pinId || '').toUpperCase() === expected;
}

export class NeopixelLogic extends BaseComponent {
    private edgeLastCycle = 0;
    private edgeCyclesPerUs = 16;

    private bitCount = 0;
    private byteValue = 0;
    private byteBuffer: number[] = [];

    private readonly wsBitOneThresholdUs = 0.55;
    private readonly wsResetThresholdUs = 45;

    constructor(id: string, manifest: any) {
        super(id, manifest);
        this.state = { pixels: [] };
    }

    private resetFrameBuilder() {
        this.bitCount = 0;
        this.byteValue = 0;
    }

    private pushBit(bit: number) {
        this.byteValue = ((this.byteValue << 1) | (bit ? 1 : 0)) & 0xff;
        this.bitCount += 1;
        if (this.bitCount >= 8) {
            this.byteBuffer.push(this.byteValue & 0xff);
            this.byteValue = 0;
            this.bitCount = 0;
        }
    }

    private flushPixels() {
        if (this.byteBuffer.length === 0) {
            this.resetFrameBuilder();
            return;
        }

        const pixels: number[] = [];
        for (let i = 0; i < this.byteBuffer.length; i += 3) {
            const g = this.byteBuffer[i] || 0;
            const r = this.byteBuffer[i + 1] || 0;
            const b = this.byteBuffer[i + 2] || 0;
            pixels.push(((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff));
        }

        this.state.pixels = pixels;
        this.stateChanged = true;
        this.byteBuffer = [];
        this.resetFrameBuilder();
    }

    private decodeEdgeFallback(isHigh: boolean, cpuCycles: number) {
        // Edge-based decoder with dynamic timing calibration for 16MHz AVR and 125MHz RP2040 paths.
        if (this.edgeLastCycle <= 0) {
            this.edgeLastCycle = cpuCycles;
            return;
        }

        const elapsed = cpuCycles - this.edgeLastCycle;
        this.edgeLastCycle = cpuCycles;

        const resetThresholdCycles = Math.max(300, this.edgeCyclesPerUs * this.wsResetThresholdUs);
        const bitOneThresholdCycles = Math.max(6, this.edgeCyclesPerUs * this.wsBitOneThresholdUs);

        if (isHigh) {
            if (elapsed > resetThresholdCycles) {
                const estimated = elapsed / this.wsResetThresholdUs;
                if (Number.isFinite(estimated) && estimated >= 8 && estimated <= 512) {
                    this.edgeCyclesPerUs = estimated;
                }

                if (this.byteBuffer.length > 0) {
                    this.flushPixels();
                } else {
                    this.resetFrameBuilder();
                }
            }
            return;
        }

        const bit = elapsed >= bitOneThresholdCycles ? 1 : 0;
        this.pushBit(bit);
    }

    onPinStateChange(pinId: string, isHigh: boolean, cpuCycles: number) {
        if (!samePin(pinId, 'DIN')) return;
        this.decodeEdgeFallback(isHigh, cpuCycles);
    }

    onPulseHigh(pinId: string, payload: any) {
        void pinId;
        void payload;
    }

    onPulseLow(pinId: string, payload: any) {
        void pinId;
        void payload;
    }

    onOneWireReset(pinId: string) {
        void pinId;
    }

    onOneWireWriteBit(pinId: string, bit: number) {
        void pinId;
        void bit;
    }

    onOneWireSlot(pinId: string, payload: any) {
        void pinId;
        void payload;
    }
}
