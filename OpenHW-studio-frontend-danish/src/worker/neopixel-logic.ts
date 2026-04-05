import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';

function samePin(pinId: string, expected: string) {
    return String(pinId || '').toUpperCase() === expected;
}

export class NeopixelLogic extends BaseComponent {
    private usePulseDecoder = false;

    private edgeLastCycle = 0;
    private edgeBitCount = 0;
    private edgeByteValue = 0;

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

    private enablePulseDecoder() {
        if (this.usePulseDecoder) return;

        this.usePulseDecoder = true;
        this.edgeLastCycle = 0;
        this.edgeBitCount = 0;
        this.edgeByteValue = 0;
        this.byteBuffer = [];
        this.resetFrameBuilder();
    }

    private decodeEdgeFallback(isHigh: boolean, cpuCycles: number) {
        // Legacy edge-based fallback for environments that don't publish pulse widths.
        const elapsed = cpuCycles - this.edgeLastCycle;
        this.edgeLastCycle = cpuCycles;

        if (isHigh) {
            if (elapsed > 400) {
                if (this.byteBuffer.length > 0) {
                    this.flushPixels();
                } else {
                    this.resetFrameBuilder();
                }
            }
            return;
        }

        const bit = elapsed >= 9 ? 1 : 0;
        this.edgeByteValue = ((this.edgeByteValue << 1) | bit) & 0xff;
        this.edgeBitCount += 1;

        if (this.edgeBitCount >= 8) {
            this.byteBuffer.push(this.edgeByteValue);
            this.edgeByteValue = 0;
            this.edgeBitCount = 0;
        }
    }

    onPinStateChange(pinId: string, isHigh: boolean, cpuCycles: number) {
        if (!samePin(pinId, 'DIN')) return;
        if (this.usePulseDecoder) return;
        this.decodeEdgeFallback(isHigh, cpuCycles);
    }

    onPulseHigh(pinId: string, payload: any) {
        if (!samePin(pinId, 'DIN')) return;
        this.enablePulseDecoder();

        const pulseUs = Number(payload?.pulseUs ?? payload?.highUs);
        if (!Number.isFinite(pulseUs) || pulseUs <= 0) return;

        const bit = pulseUs >= this.wsBitOneThresholdUs ? 1 : 0;
        this.pushBit(bit);
    }

    onPulseLow(pinId: string, payload: any) {
        if (!samePin(pinId, 'DIN')) return;
        this.enablePulseDecoder();

        const pulseUs = Number(payload?.pulseUs ?? payload?.lowUs);
        if (!Number.isFinite(pulseUs) || pulseUs <= 0) return;

        // WS2812 latch/reset when line stays LOW for ~50us+.
        if (pulseUs >= this.wsResetThresholdUs) {
            this.flushPixels();
        }
    }

    onOneWireReset(pinId: string) {
        // Compatibility path for older protocol shims.
        if (!samePin(pinId, 'DIN')) return;
        if (this.usePulseDecoder) return;
        this.flushPixels();
    }

    onOneWireWriteBit(pinId: string, bit: number) {
        // Compatibility path for older protocol shims.
        if (!samePin(pinId, 'DIN')) return;
        if (this.usePulseDecoder) return;
        this.pushBit(bit ? 1 : 0);
    }

    onOneWireSlot(pinId: string, payload: any) {
        if (!samePin(pinId, 'DIN')) return;
        if (this.usePulseDecoder) return;
        if (typeof payload?.bit === 'number') {
            this.pushBit(payload.bit ? 1 : 0);
        }
    }
}
