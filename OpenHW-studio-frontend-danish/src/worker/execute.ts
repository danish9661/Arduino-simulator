import { CPU, timer0Config, timer1Config, timer2Config, AVRTimer, avrInstruction, AVRADC, adcConfig, AVRUSART, usart0Config, AVRTWI, twiConfig, AVRSPI, spiConfig, AVRIOPort, portBConfig, portCConfig, portDConfig, PinState } from 'avr8js';
import { RP2040, GPIOPinState, ConsoleLogger, LogLevel, USBCDC } from 'rp2040js';
import { bootromB1 } from './rp2040-bootrom.ts';

import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';
import { LEDLogic } from '@openhw/emulator/src/components/wokwi-led/logic.ts';
import { UnoLogic } from '@openhw/emulator/src/components/wokwi-arduino-uno/logic.ts';
import { PicoLogic } from './pico-logic.ts';
import { MicroPythonRunner } from './micropython-runtime.ts';
import { ResistorLogic } from '@openhw/emulator/src/components/wokwi-resistor/logic.ts';
import { PushbuttonLogic } from '@openhw/emulator/src/components/wokwi-pushbutton/logic.ts';
import { PowerSupplyLogic } from '@openhw/emulator/src/components/wokwi-power-supply/logic.ts';
import { NeopixelLogic } from '@openhw/emulator/src/components/wokwi-neopixel-matrix/logic.ts';
import { BuzzerLogic } from '@openhw/emulator/src/components/wokwi-buzzer/logic.ts';
import { MotorLogic } from '@openhw/emulator/src/components/wokwi-motor/logic.ts';
import { ServoLogic } from '@openhw/emulator/src/components/wokwi-servo/logic.ts';
import { MotorDriverLogic } from '@openhw/emulator/src/components/wokwi-motor-driver/logic.ts';
import { SlidePotLogic } from '@openhw/emulator/src/components/wokwi-slide-potentiometer/logic.ts';
import { PotentiometerLogic } from '@openhw/emulator/src/components/wokwi-potentiometer/logic.ts';
import { ShiftRegisterLogic } from '@openhw/emulator/src/components/shift_register/logic.ts';
import {
    PICO_BOARD_PINS,
    UNO_ANALOG_PINS,
    UNO_BOARD_PINS,
    UNO_DIGITAL_PINS,
} from './board-profiles.ts';

export function parse(data: string) {
    const lines = data.split('\n');
    let highAddress = 0;
    const maxAddress = 32768; // 32KB typical Uno size
    const result = new Uint8Array(maxAddress);

    for (const line of lines) {
        if (line[0] !== ':') continue;
        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);

        if (recordType === 0) { // Data record
            for (let i = 0; i < byteCount; i++) {
                const byte = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
                const absoluteAddress = highAddress + address + i;
                if (absoluteAddress < maxAddress) {
                    result[absoluteAddress] = byte;
                }
            }
        } else if (recordType === 4 || recordType === 2) { // Extended linear/segment address
            highAddress = parseInt(line.substring(9, 13), 16) << (recordType === 4 ? 16 : 4);
        } // ignore recordTypes 1 (EOF) and others for this simple parser
    }
    return { data: result };
}

const LITTLEFS_MODULE_NAME = 'littlefs';
const SD_BLOCK_SIZE = 512;
const SD_DATA_TOKEN = 0xfe;

type LittleFsVolume = {
    mount: () => number;
    unmount: () => number;
    format: () => number;
    formatAndMount: () => number;
    writeFile: (path: string, data: Uint8Array) => boolean;
    destroy: () => void;
};

function toUint8Array(data: any, encoder: TextEncoder): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data.map((v) => Number(v) & 0xff));
    return encoder.encode(String(data ?? ''));
}

async function tryLoadLittleFsFactory(): Promise<((options?: any) => Promise<any>) | null> {
    try {
        const mod = await import(/* @vite-ignore */ LITTLEFS_MODULE_NAME);
        const candidate = (mod as any)?.default ?? mod;
        return typeof candidate === 'function' ? candidate : null;
    } catch {
        return null;
    }
}

function createLittleFsVolume(
    littlefs: any,
    storage: Uint8Array,
    blockSize: number,
    blockCount: number
): LittleFsVolume | null {
    if (!littlefs || typeof littlefs.addFunction !== 'function' || typeof littlefs._new_lfs !== 'function' || typeof littlefs._new_lfs_config !== 'function') {
        return null;
    }
    if (typeof littlefs._lfs_mount !== 'function' || typeof littlefs._lfs_unmount !== 'function' || typeof littlefs._lfs_format !== 'function') {
        return null;
    }

    const tablePointers: number[] = [];
    const addFn = (fn: (...args: any[]) => number, signature: string) => {
        const ptr = Number(littlefs.addFunction(fn, signature));
        tablePointers.push(ptr);
        return ptr;
    };

    const read = addFn((cfg: number, block: number, off: number, buffer: number, size: number) => {
        void cfg;
        const start = block * blockSize + off;
        if (start < 0 || (start + size) > storage.length) return -5;
        littlefs.HEAPU8.set(storage.subarray(start, start + size), buffer);
        return 0;
    }, 'iiiiii');

    const prog = addFn((cfg: number, block: number, off: number, buffer: number, size: number) => {
        void cfg;
        const start = block * blockSize + off;
        if (start < 0 || (start + size) > storage.length) return -5;
        storage.set(littlefs.HEAPU8.subarray(buffer, buffer + size), start);
        return 0;
    }, 'iiiiii');

    const erase = addFn((cfg: number, block: number) => {
        void cfg;
        const start = block * blockSize;
        if (start < 0 || (start + blockSize) > storage.length) return -5;
        storage.fill(0xff, start, start + blockSize);
        return 0;
    }, 'iii');

    const sync = addFn((cfg: number) => {
        void cfg;
        return 0;
    }, 'ii');

    const config = Number(littlefs._new_lfs_config(read, prog, erase, sync, blockCount, blockSize));
    const lfs = Number(littlefs._new_lfs());
    if (!Number.isFinite(config) || !Number.isFinite(lfs) || config <= 0 || lfs <= 0) {
        return null;
    }

    const cwrapWrite = typeof littlefs.cwrap === 'function'
        ? littlefs.cwrap('lfs_write_file', null, ['number', 'string', 'number', 'number'])
        : null;

    const mount = () => Number(littlefs._lfs_mount(lfs, config) ?? -1);
    const unmount = () => Number(littlefs._lfs_unmount(lfs) ?? -1);
    const format = () => Number(littlefs._lfs_format(lfs, config) ?? -1);
    const formatAndMount = () => {
        const fr = format();
        if (fr < 0) return fr;
        return mount();
    };

    const writeFile = (path: string, data: Uint8Array) => {
        if (typeof cwrapWrite !== 'function' || typeof littlefs._malloc !== 'function' || typeof littlefs._free !== 'function') {
            return false;
        }

        let ptr = 0;
        try {
            const size = data.length;
            ptr = Number(littlefs._malloc(Math.max(size, 1)));
            if (!Number.isFinite(ptr) || ptr <= 0) return false;
            if (size > 0) {
                littlefs.HEAPU8.set(data, ptr);
            }
            cwrapWrite(lfs, path, ptr, size);
            return true;
        } catch {
            return false;
        } finally {
            if (ptr > 0) {
                try {
                    littlefs._free(ptr);
                } catch {
                    // ignore
                }
            }
        }
    };

    const destroy = () => {
        try {
            if (typeof littlefs._free === 'function') {
                littlefs._free(lfs);
                littlefs._free(config);
            }
        } catch {
            // ignore
        }

        if (typeof littlefs.removeFunction === 'function') {
            tablePointers.forEach((ptr) => {
                try {
                    littlefs.removeFunction(ptr);
                } catch {
                    // ignore
                }
            });
        }
    };

    return {
        mount,
        unmount,
        format,
        formatAndMount,
        writeFile,
        destroy,
    };
}

class SDCardLogic extends BaseComponent {
    private powered = false;
    private csHigh = true;
    private mounted = true;
    private appCmdPending = false;
    private responseQueue: number[] = [];
    private commandFrame: number[] = [];
    private writeState: { blockIndex: number; stage: 'token' | 'payload' | 'crc1' | 'crc2'; data: number[] } | null = null;
    private bytesIn = 0;
    private bytesOut = 0;
    private lastActivityAt = 0;

    private readonly textEncoder = new TextEncoder();
    private readonly textDecoder = new TextDecoder();
    private readonly blockSize = SD_BLOCK_SIZE;
    private readonly blockCount: number;
    private readonly storage: Uint8Array;

    private backendName = 'memory';
    private littleFsReady = false;
    private littleFsVolume: LittleFsVolume | null = null;
    private files = new Map<string, Uint8Array>();

    constructor(id: string, manifest: any) {
        super(id, manifest);

        const capacityKbRaw = Number(manifest?.attrs?.capacityKB ?? 2048);
        const capacityKB = Number.isFinite(capacityKbRaw) && capacityKbRaw > 64
            ? Math.floor(capacityKbRaw)
            : 2048;

        this.blockCount = Math.max(64, Math.floor((capacityKB * 1024) / this.blockSize));
        this.storage = new Uint8Array(this.blockCount * this.blockSize);
        this.storage.fill(0xff);
        this.mounted = String(manifest?.attrs?.mounted ?? 'true') !== 'false';

        this.writeShadowFile('/README.TXT', this.textEncoder.encode('OpenHW virtual SD card\n'));

        this.state = {
            mounted: this.mounted,
            powered: false,
            selected: false,
            activity: false,
            backend: this.backendName,
            fsReady: this.littleFsReady,
            fileCount: this.files.size,
            usedBytes: this.computeUsedBytes(),
            bytesIn: 0,
            bytesOut: 0,
            capacityKB,
            blockSize: this.blockSize,
            blockCount: this.blockCount,
            lastCommand: '--',
            lastPath: '--',
            lastOp: 'idle',
            lastReadPreview: '',
        };

        void this.initLittleFsBackend();
    }

    private normalizePath(pathLike: string): string {
        const raw = String(pathLike || '').trim().replace(/\\/g, '/');
        if (!raw) return '/UNTITLED.TXT';
        return raw.startsWith('/') ? raw : `/${raw}`;
    }

    private computeUsedBytes(): number {
        let total = 0;
        this.files.forEach((v) => {
            total += v.length;
        });
        return total;
    }

    private updateFsCounters() {
        this.state.fileCount = this.files.size;
        this.state.usedBytes = this.computeUsedBytes();
        this.stateChanged = true;
    }

    private writeShadowFile(path: string, bytes: Uint8Array) {
        this.files.set(this.normalizePath(path), new Uint8Array(bytes));
        this.updateFsCounters();
    }

    private refreshPowerState() {
        const nextPowered = this.getPinVoltage('VCC') > 2.0;
        if (nextPowered !== this.powered) {
            this.powered = nextPowered;
            this.state.powered = this.powered;
            this.stateChanged = true;
        }
    }

    private resetSpiTransactionState() {
        this.appCmdPending = false;
        this.responseQueue = [];
        this.commandFrame = [];
        this.writeState = null;
    }

    private setMounted(nextMounted: boolean) {
        if (this.mounted === nextMounted) return;
        this.mounted = nextMounted;
        this.state.mounted = nextMounted;
        if (!nextMounted) {
            this.resetSpiTransactionState();
        }
        this.stateChanged = true;
    }

    private queueResponse(bytes: number[]) {
        this.responseQueue.push(...bytes.map((v) => v & 0xff));
    }

    private emitResponseByte() {
        const out = this.responseQueue.length > 0 ? (this.responseQueue.shift() as number) : 0xff;
        this.bytesOut += 1;
        this.state.bytesOut = this.bytesOut;
        this.stateChanged = true;
        return out & 0xff;
    }

    private parseBlockIndex(commandArg: number): number | null {
        const asBlockAddress = commandArg >>> 0;
        if (asBlockAddress < this.blockCount) return asBlockAddress;

        const byByteAddress = Math.floor((commandArg >>> 0) / this.blockSize);
        if (byByteAddress >= 0 && byByteAddress < this.blockCount) {
            return byByteAddress;
        }
        return null;
    }

    private queueReadBlock(blockIndex: number) {
        const start = blockIndex * this.blockSize;
        const payload = this.storage.subarray(start, start + this.blockSize);
        this.queueResponse([0x00, 0xff, SD_DATA_TOKEN, ...payload, 0xff, 0xff]);
    }

    private beginWriteBlock(blockIndex: number) {
        this.writeState = {
            blockIndex,
            stage: 'token',
            data: [],
        };
        this.queueResponse([0x00]);
    }

    private completeWriteBlock() {
        if (!this.writeState) return;

        const { blockIndex, data } = this.writeState;
        const start = blockIndex * this.blockSize;
        const payload = data.length >= this.blockSize
            ? data.slice(0, this.blockSize)
            : [...data, ...new Array(this.blockSize - data.length).fill(0xff)];

        this.storage.set(Uint8Array.from(payload), start);
        this.writeState = null;

        // Data accepted token (0bXXX00101), then one ready byte.
        this.queueResponse([0x05, 0xff]);
        this.state.lastOp = 'write-block';
        this.stateChanged = true;
    }

    private handleWriteByte(value: number) {
        if (!this.writeState) return;

        const byte = value & 0xff;
        if (this.writeState.stage === 'token') {
            if (byte === SD_DATA_TOKEN) {
                this.writeState.stage = 'payload';
            }
            return;
        }

        if (this.writeState.stage === 'payload') {
            this.writeState.data.push(byte);
            if (this.writeState.data.length >= this.blockSize) {
                this.writeState.stage = 'crc1';
            }
            return;
        }

        if (this.writeState.stage === 'crc1') {
            this.writeState.stage = 'crc2';
            return;
        }

        if (this.writeState.stage === 'crc2') {
            this.completeWriteBlock();
        }
    }

    private handleCommandFrame(frame: number[]) {
        const commandByte = frame[0] & 0xff;
        const command = commandByte & 0x3f;
        const arg = ((frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4]) >>> 0;

        this.state.lastCommand = `CMD${String(command).padStart(2, '0')}`;

        if (command === 0) {
            this.appCmdPending = false;
            this.queueResponse([0x01]);
            return;
        }

        if (command === 8) {
            this.queueResponse([0x01, 0x00, 0x00, 0x01, 0xaa]);
            return;
        }

        if (command === 55) {
            this.appCmdPending = true;
            this.queueResponse([0x01]);
            return;
        }

        if (command === 41 && this.appCmdPending) {
            this.appCmdPending = false;
            this.queueResponse([0x00]);
            return;
        }

        if (command === 58) {
            // OCR with CCS bit set (SDHC-compatible addressing for simulator simplicity).
            this.queueResponse([0x00, 0x40, 0x00, 0x00, 0x00]);
            return;
        }

        if (command === 17) {
            const blockIndex = this.parseBlockIndex(arg);
            if (blockIndex === null) {
                this.queueResponse([0x04]);
            } else {
                this.queueReadBlock(blockIndex);
                this.state.lastOp = 'read-block';
            }
            this.stateChanged = true;
            return;
        }

        if (command === 24) {
            const blockIndex = this.parseBlockIndex(arg);
            if (blockIndex === null) {
                this.queueResponse([0x04]);
            } else {
                this.beginWriteBlock(blockIndex);
                this.state.lastOp = 'write-block';
            }
            this.stateChanged = true;
            return;
        }

        // Generic "accepted" for unsupported commands.
        this.queueResponse([0x00]);
    }

    private async initLittleFsBackend() {
        const factory = await tryLoadLittleFsFactory();
        if (!factory) return;

        try {
            const littlefs = await factory({});
            const volume = createLittleFsVolume(littlefs, this.storage, this.blockSize, this.blockCount);
            if (!volume) return;

            const rc = volume.formatAndMount();
            if (rc < 0) {
                volume.destroy();
                return;
            }

            this.littleFsVolume = volume;
            this.backendName = 'littlefs-wasm';
            this.littleFsReady = true;

            // Mirror known files into the mounted littlefs volume.
            this.files.forEach((data, path) => {
                volume.writeFile(path, data);
            });

            this.state.backend = this.backendName;
            this.state.fsReady = true;
            this.stateChanged = true;
        } catch {
            // Keep memory backend if module init fails.
        }
    }

    private formatCard() {
        this.storage.fill(0xff);
        this.files.clear();
        this.writeShadowFile('/README.TXT', this.textEncoder.encode('OpenHW virtual SD card\n'));

        if (this.littleFsVolume && this.littleFsReady) {
            try {
                this.littleFsVolume.formatAndMount();
                this.files.forEach((data, path) => {
                    this.littleFsVolume!.writeFile(path, data);
                });
            } catch {
                // keep shadow storage as fallback
            }
        }

        this.state.lastOp = 'format';
        this.state.lastPath = '/';
        this.stateChanged = true;
    }

    private writeFile(pathLike: string, data: any) {
        const path = this.normalizePath(pathLike);
        const bytes = toUint8Array(data, this.textEncoder);

        this.writeShadowFile(path, bytes);
        if (this.littleFsVolume && this.littleFsReady) {
            this.littleFsVolume.writeFile(path, bytes);
        }

        this.state.lastPath = path;
        this.state.lastOp = 'write-file';
        this.stateChanged = true;
    }

    private readFile(pathLike: string): Uint8Array | null {
        const path = this.normalizePath(pathLike);
        const found = this.files.get(path) || null;
        if (!found) {
            this.state.lastPath = path;
            this.state.lastOp = 'read-miss';
            this.state.lastReadPreview = '';
            this.stateChanged = true;
            return null;
        }

        const previewBytes = found.subarray(0, Math.min(found.length, 80));
        this.state.lastPath = path;
        this.state.lastOp = 'read-file';
        this.state.lastReadPreview = this.textDecoder.decode(previewBytes);
        this.stateChanged = true;
        return new Uint8Array(found);
    }

    onPinStateChange(pinId: string, isHigh: boolean) {
        const pin = String(pinId || '').toUpperCase();
        if (pin === 'CS') {
            this.csHigh = isHigh;
            this.state.selected = !this.csHigh;
            if (this.csHigh) {
                this.commandFrame = [];
                this.writeState = null;
            }
            this.stateChanged = true;
            return;
        }

        if (pin === 'VCC' || pin === 'GND') {
            this.refreshPowerState();
        }
    }

    onEvent(event: any) {
        const type = String(event?.type || '').toUpperCase();
        if (!type) return;

        if (type === 'SD_MOUNT' || type === 'MOUNT') {
            this.setMounted(true);
            this.state.lastOp = 'mount';
            return;
        }

        if (type === 'SD_UNMOUNT' || type === 'UNMOUNT' || type === 'EJECT') {
            this.setMounted(false);
            this.state.lastOp = 'unmount';
            return;
        }

        if (type === 'SD_FORMAT' || type === 'FORMAT') {
            this.formatCard();
            return;
        }

        if (type === 'SD_WRITE_FILE' || type === 'WRITE_FILE') {
            this.writeFile(event?.path || event?.name || '/LOG.TXT', event?.data ?? event?.content ?? '');
            return;
        }

        if (type === 'SD_READ_FILE' || type === 'READ_FILE') {
            this.readFile(event?.path || event?.name || '/README.TXT');
            return;
        }

        if (type === 'SD_DELETE_FILE' || type === 'DELETE_FILE') {
            const path = this.normalizePath(event?.path || event?.name || '');
            if (this.files.delete(path)) {
                this.state.lastPath = path;
                this.state.lastOp = 'delete-file';
                this.updateFsCounters();
                this.stateChanged = true;
            }
        }
    }

    onSPIByte(value: number) {
        this.refreshPowerState();

        if (!this.mounted || !this.powered || this.csHigh) {
            return 0xff;
        }

        const byte = value & 0xff;
        this.lastActivityAt = Date.now();
        this.bytesIn += 1;
        this.state.bytesIn = this.bytesIn;

        if (this.responseQueue.length > 0) {
            return this.emitResponseByte();
        }

        if (this.writeState) {
            this.handleWriteByte(byte);
            return this.emitResponseByte();
        }

        if (this.commandFrame.length === 0) {
            if ((byte & 0xc0) === 0x40) {
                this.commandFrame.push(byte);
            } else if (byte === 0x9f) {
                // Legacy SPI probe compatibility.
                this.queueResponse([0x53, 0x44, 0x30]);
            }
            return this.emitResponseByte();
        }

        this.commandFrame.push(byte);
        if (this.commandFrame.length >= 6) {
            const frame = this.commandFrame.slice(0, 6);
            this.commandFrame = [];
            this.handleCommandFrame(frame);
        }

        return this.emitResponseByte();
    }

    update() {
        this.refreshPowerState();

        const active = (Date.now() - this.lastActivityAt) < 120;
        if (this.state.activity !== active) {
            this.state.activity = active;
            this.stateChanged = true;
        }

        const fileCount = this.files.size;
        if (this.state.fileCount !== fileCount) {
            this.state.fileCount = fileCount;
            this.stateChanged = true;
        }

        const usedBytes = this.computeUsedBytes();
        if (this.state.usedBytes !== usedBytes) {
            this.state.usedBytes = usedBytes;
            this.stateChanged = true;
        }
    }
}

export const LOGIC_REGISTRY: Record<string, any> = {
    'wokwi-led': LEDLogic,
    'wokwi-arduino-uno': UnoLogic,
    'wokwi-raspberry-pi-pico': PicoLogic,
    'wokwi-resistor': ResistorLogic,
    'wokwi-pushbutton': PushbuttonLogic,
    'wokwi-power-supply': PowerSupplyLogic,
    'wokwi-neopixel-matrix': NeopixelLogic,
    'wokwi-buzzer': BuzzerLogic,
    'wokwi-motor': MotorLogic,
    'wokwi-servo': ServoLogic,
    'wokwi-motor-driver': MotorDriverLogic,
    'wokwi-slide-potentiometer': SlidePotLogic,
    'wokwi-potentiometer': PotentiometerLogic,
    'wokwi-sd-card': SDCardLogic,
    'shift_register': ShiftRegisterLogic,
};

// Per-type pin lists so every component's pins are registered correctly
export const COMPONENT_PINS: Record<string, { id: string }[]> = {
    'wokwi-led': [{ id: 'A' }, { id: 'K' }],
    'wokwi-arduino-uno': UNO_BOARD_PINS.map((id: string) => ({ id })),
    'wokwi-raspberry-pi-pico': PICO_BOARD_PINS.map((id: string) => ({ id })),
    'wokwi-resistor': [{ id: 'p1' }, { id: 'p2' }],
    'wokwi-pushbutton': [{ id: '1' }, { id: '2' }],
    'wokwi-buzzer': [{ id: '1' }, { id: '2' }],
    'wokwi-neopixel-matrix': [{ id: 'DIN' }, { id: 'VCC' }, { id: 'GND' }],
    'wokwi-servo': [{ id: 'GND' }, { id: 'V+' }, { id: 'PWM' }],
    'wokwi-motor': [{ id: '1' }, { id: '2' }],
    'wokwi-motor-driver': [{ id: 'ENA' }, { id: 'ENB' }, { id: 'IN1' }, { id: 'IN2' }, { id: 'IN3' }, { id: 'IN4' }, { id: 'OUT1' }, { id: 'OUT2' }, { id: 'OUT3' }, { id: 'OUT4' }, { id: '12V' }, { id: '5V' }, { id: 'GND' }],
    'wokwi-potentiometer': [{ id: '1' }, { id: '2' }, { id: 'SIG' }],
    'wokwi-slide-potentiometer': [{ id: 'GND' }, { id: 'SIG' }, { id: 'VCC' }],
    'wokwi-sd-card': [{ id: 'VCC' }, { id: 'GND' }, { id: 'CS' }, { id: 'SCK' }, { id: 'MOSI' }, { id: 'MISO' }],
    'wokwi-power-supply': [{ id: 'GND' }, { id: 'VCC' }],
    'shift_register': [{ id: 'vcc' }, { id: 'gnd' }, { id: 'ser' }, { id: 'srclk' }, { id: 'rclk' }, { id: 'oe' }, { id: 'srclr' }, { id: 'q0' }, { id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' }, { id: 'q5' }, { id: 'q6' }, { id: 'q7' }, { id: 'q7s' }],
};

export type AVRRunnerOptions = {
    boardId?: string;
    onByteTransmit?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    serialBaudRate?: number;
    debugEnabled?: boolean;
    debugIntervalMs?: number;
    forceMicroPythonJsRunner?: boolean;
};

export type BoardRunner = {
    cpu: any;
    boardId: string;
    instances: Map<string, BaseComponent>;
    stop: () => void;
    reset?: () => void;
    serialRx: (data: string) => void;
    serialRxByte: (value: number) => void;
    setSerialBaudRate: (baud: number) => void;
    getSerialBaudRate: () => number;
};

const RP2040_FLASH_BASE = 0x10000000;
const RP2040_XIP_NOCACHE_BASE = 0x11000000;
const RP2040_BOOTROM_BASE = 0x00000000;
const RP2040_BOOTROM_SIZE = 0x4000;
const RP2040_SRAM_BASE = 0x20000000;
const RP2040_CLOCKS_BASE = 0x40008000;
const RP2040_CLOCKS_CLK_REF_CTRL_OFFSET = 0x30;
const RP2040_CLOCKS_CLK_REF_SELECTED_OFFSET = 0x38;
const RP2040_CLOCKS_CLK_SYS_CTRL_OFFSET = 0x3c;
const RP2040_CLOCKS_CLK_SYS_SELECTED_OFFSET = 0x44;
const UF2_PAYLOAD_PREFIX = 'UF2BASE64:';
const UF2_BLOCK_SIZE = 512;
const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;

type HexSegment = {
    address: number;
    bytes: Uint8Array;
};

type RP2040EntryInfo = {
    vectorBase: number;
    initialSP: number;
    initialPC: number;
    resolvedPC: number;
    usedFallback: boolean;
    strategy?: string;
    fallbackReason?: string;
    probe0100SP?: number;
    probe0100PC?: number;
    probe0000SP?: number;
    probe0000PC?: number;
};

function parseIntelHexSegments(data: string): HexSegment[] {
    const lines = String(data || '').split(/\r?\n/);
    let highAddress = 0;
    const segments: HexSegment[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line[0] !== ':') continue;
        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);

        if (recordType === 0) {
            const bytes = new Uint8Array(byteCount);
            for (let i = 0; i < byteCount; i++) {
                bytes[i] = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
            }
            segments.push({
                address: highAddress + address,
                bytes,
            });
        } else if (recordType === 4 || recordType === 2) {
            highAddress = parseInt(line.substring(9, 13), 16) << (recordType === 4 ? 16 : 4);
        }
    }

    return segments;
}

function loadRP2040Entry(rp2040: RP2040): RP2040EntryInfo {
    const flashEnd = (RP2040_FLASH_BASE + rp2040.flash.length) >>> 0;
    const flashNoCacheEnd = (RP2040_XIP_NOCACHE_BASE + rp2040.flash.length) >>> 0;
    const sramStart = RP2040_SRAM_BASE;
    const sramEnd = (RP2040_SRAM_BASE + rp2040.sram.length) >>> 0;

    const resolvePcAddress = (rawAddress: number): number => {
        const raw = rawAddress >>> 0;
        if (raw < rp2040.flash.length) {
            return (RP2040_FLASH_BASE + raw) >>> 0;
        }
        return raw;
    };

    const isExecutableAddress = (addr: number): boolean => {
        const a = addr >>> 0;
        return (a >= RP2040_FLASH_BASE && a < flashEnd)
            || (a >= RP2040_XIP_NOCACHE_BASE && a < flashNoCacheEnd)
            || (a >= sramStart && a < sramEnd)
            || (a >= RP2040_BOOTROM_BASE && a < (RP2040_BOOTROM_BASE + RP2040_BOOTROM_SIZE));
    };

    const hasInstructionWord = (addr: number): boolean => {
        const a = addr >>> 0;
        let flashIndex = -1;

        if (a >= RP2040_FLASH_BASE && a < flashEnd) {
            flashIndex = a - RP2040_FLASH_BASE;
        } else if (a >= RP2040_XIP_NOCACHE_BASE && a < flashNoCacheEnd) {
            flashIndex = a - RP2040_XIP_NOCACHE_BASE;
        }

        if (flashIndex < 0) return true;
        if (flashIndex + 1 >= rp2040.flash.length) return false;
        return !(rp2040.flash[flashIndex] === 0xff && rp2040.flash[flashIndex + 1] === 0xff);
    };

    const readWord = (addr: number): number => {
        const a = addr >>> 0;

        let flashIndex = -1;
        if (a >= RP2040_FLASH_BASE && (a + 3) < flashEnd) {
            flashIndex = a - RP2040_FLASH_BASE;
        } else if (a >= RP2040_XIP_NOCACHE_BASE && (a + 3) < flashNoCacheEnd) {
            flashIndex = a - RP2040_XIP_NOCACHE_BASE;
        }

        if (flashIndex >= 0 && flashIndex + 3 < rp2040.flash.length) {
            return (
                (rp2040.flash[flashIndex])
                | (rp2040.flash[flashIndex + 1] << 8)
                | (rp2040.flash[flashIndex + 2] << 16)
                | (rp2040.flash[flashIndex + 3] << 24)
            ) >>> 0;
        }

        return rp2040.readUint32(a) >>> 0;
    };

    const probe0100SP = readWord((RP2040_FLASH_BASE + 0x100) >>> 0) >>> 0;
    const probe0100PC = readWord((RP2040_FLASH_BASE + 0x104) >>> 0) >>> 0;
    const probe0000SP = readWord(RP2040_FLASH_BASE) >>> 0;
    const probe0000PC = readWord((RP2040_FLASH_BASE + 4) >>> 0) >>> 0;

    const tryVectorBase = (base: number, strategy: string): RP2040EntryInfo | null => {
        const initialSP = readWord(base) >>> 0;
        const initialPC = readWord((base + 4) >>> 0) >>> 0;

        if (initialSP === 0 || initialPC === 0 || initialSP === 0xffffffff || initialPC === 0xffffffff) {
            return null;
        }

        const pcAddress = resolvePcAddress((initialPC & ~1) >>> 0);
        // Accept vectors that use the exact top-of-SRAM address as initial SP.
        // RP2040 toolchains commonly emit SP == sramEnd.
        const validSP = initialSP >= sramStart
            && initialSP <= sramEnd
            && (initialSP & 0x3) === 0;
        const validPC = isExecutableAddress(pcAddress) && hasInstructionWord(pcAddress);
        if (!validSP || !validPC) {
            return null;
        }

        rp2040.core.SP = initialSP;
        rp2040.core.VTOR = base >>> 0;
        rp2040.core.BXWritePC(((pcAddress | 1) >>> 0));
        rp2040.core.xPSR = 0x01000000;
        return {
            vectorBase: base >>> 0,
            initialSP,
            initialPC,
            resolvedPC: pcAddress >>> 0,
            usedFallback: false,
            strategy,
            probe0100SP,
            probe0100PC,
            probe0000SP,
            probe0000PC,
        };
    };

    // Wokwi-compatible deterministic startup order:
    // - Prefer app vector at +0x100 (typical boot2-prefixed RP2040 images)
    // - Then allow +0x000 for images without boot2 prefix.
    const preferred = tryVectorBase((RP2040_FLASH_BASE + 0x100) >>> 0, 'vector+0x100');
    if (preferred) return preferred;

    const zeroBase = tryVectorBase(RP2040_FLASH_BASE >>> 0, 'vector+0x000');
    if (zeroBase) return zeroBase;

    const fallbackBase = (RP2040_FLASH_BASE + 0x100) >>> 0;
    const fallbackVectorSp = readWord(fallbackBase) >>> 0;
    const fallbackVectorPc = readWord((fallbackBase + 4) >>> 0) >>> 0;
    const fallbackResolvedPc = resolvePcAddress((fallbackVectorPc & ~1) >>> 0);

    const fallbackSp = (fallbackVectorSp >= sramStart
        && fallbackVectorSp <= sramEnd
        && (fallbackVectorSp & 0x3) === 0)
        ? fallbackVectorSp
        : (Math.max(sramStart + 0x100, (sramEnd - 0x100) >>> 0) >>> 0);

    const fallbackPc = (fallbackVectorPc !== 0
        && fallbackVectorPc !== 0xffffffff
        && isExecutableAddress(fallbackResolvedPc))
        ? fallbackResolvedPc
        : fallbackBase;

    rp2040.core.SP = fallbackSp;
    rp2040.core.VTOR = fallbackBase >>> 0;
    rp2040.core.BXWritePC((fallbackPc | 1) >>> 0);
    rp2040.core.xPSR = 0x01000000;

    return {
        vectorBase: fallbackBase,
        initialSP: fallbackSp,
        initialPC: (fallbackVectorPc !== 0 && fallbackVectorPc !== 0xffffffff)
            ? fallbackVectorPc
            : ((fallbackPc | 1) >>> 0),
        resolvedPC: fallbackPc,
        usedFallback: true,
        strategy: 'fallback+0x100',
        fallbackReason: 'no_valid_vector_table',
        probe0100SP,
        probe0100PC,
        probe0000SP,
        probe0000PC,
    };
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const normalized = String(base64 || '').replace(/\s+/g, '');
    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
    return out;
}

function loadRP2040FirmwareFromUF2Payload(rp2040: RP2040, uf2Payload: string): RP2040EntryInfo {
    const payload = String(uf2Payload || '').startsWith(UF2_PAYLOAD_PREFIX)
        ? String(uf2Payload).slice(UF2_PAYLOAD_PREFIX.length)
        : String(uf2Payload || '');

    const bytes = decodeBase64ToBytes(payload);
    const blockCount = Math.floor(bytes.length / UF2_BLOCK_SIZE);

    for (let i = 0; i < blockCount; i++) {
        const offset = i * UF2_BLOCK_SIZE;
        const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, UF2_BLOCK_SIZE);
        const m0 = dv.getUint32(0, true);
        const m1 = dv.getUint32(4, true);
        const mEnd = dv.getUint32(508, true);
        if (m0 !== UF2_MAGIC_START0 || m1 !== UF2_MAGIC_START1 || mEnd !== UF2_MAGIC_END) continue;

        const targetAddr = dv.getUint32(12, true) >>> 0;
        const payloadSize = dv.getUint32(16, true) >>> 0;
        if (payloadSize === 0 || payloadSize > 476) continue;

        let dstStart = -1;
        if (targetAddr >= RP2040_FLASH_BASE && targetAddr < (RP2040_FLASH_BASE + rp2040.flash.length)) {
            dstStart = targetAddr - RP2040_FLASH_BASE;
        } else if (targetAddr >= RP2040_XIP_NOCACHE_BASE && targetAddr < (RP2040_XIP_NOCACHE_BASE + rp2040.flash.length)) {
            dstStart = targetAddr - RP2040_XIP_NOCACHE_BASE;
        } else if (targetAddr < rp2040.flash.length) {
            dstStart = targetAddr;
        }
        if (dstStart < 0 || dstStart >= rp2040.flash.length) continue;

        const maxCopy = Math.min(payloadSize, rp2040.flash.length - dstStart);
        if (maxCopy <= 0) continue;

        const payloadOffset = offset + 32;
        rp2040.flash.set(bytes.subarray(payloadOffset, payloadOffset + maxCopy), dstStart);
    }

    return loadRP2040Entry(rp2040);
}

function loadRP2040FirmwareFromHex(rp2040: RP2040, firmwareHex: string): RP2040EntryInfo {
    const segments = parseIntelHexSegments(firmwareHex);
    let flashBytesWritten = 0;

    for (const seg of segments) {
        const segStart = seg.address >>> 0;
        const segEnd = (seg.address + seg.bytes.length) >>> 0;
        const flashStart = RP2040_FLASH_BASE;
        const flashEnd = RP2040_FLASH_BASE + rp2040.flash.length;

        if (segEnd <= flashStart || segStart >= flashEnd) {
            continue;
        }

        const copyStart = Math.max(segStart, flashStart);
        const copyEnd = Math.min(segEnd, flashEnd);
        const srcOffset = copyStart - segStart;
        const dstOffset = copyStart - flashStart;
        const copyLength = copyEnd - copyStart;

        rp2040.flash.set(seg.bytes.subarray(srcOffset, srcOffset + copyLength), dstOffset);
        flashBytesWritten += copyLength;
    }

    if (flashBytesWritten === 0 && segments.length > 0) {
        // Some toolchains emit HEX with low addresses; treat them as flash offsets.
        for (const seg of segments) {
            if (seg.address < rp2040.flash.length) {
                const dstOffset = seg.address;
                const maxCopy = Math.max(0, Math.min(seg.bytes.length, rp2040.flash.length - dstOffset));
                if (maxCopy > 0) {
                    rp2040.flash.set(seg.bytes.subarray(0, maxCopy), dstOffset);
                    flashBytesWritten += maxCopy;
                }
            }
        }
    }

    return loadRP2040Entry(rp2040);
}

function loadRP2040Firmware(rp2040: RP2040, firmware: string): RP2040EntryInfo {
    // Reset flash contents before each load so stale data cannot execute.
    rp2040.flash.fill(0xff);

    const source = String(firmware || '').trim();
    if (!source) {
        return loadRP2040Entry(rp2040);
    }

    if (source.startsWith(UF2_PAYLOAD_PREFIX)) {
        return loadRP2040FirmwareFromUF2Payload(rp2040, source);
    }

    return loadRP2040FirmwareFromHex(rp2040, source);
}

export class AVRRunner {
    cpu: CPU | null = null;
    adc: AVRADC | null = null;
    usart: AVRUSART | null = null;
    twi: AVRTWI | null = null;
    spi: AVRSPI | null = null;
    portB: AVRIOPort | null = null;
    portC: AVRIOPort | null = null;
    portD: AVRIOPort | null = null;
    updatePhysics: (() => void) | null = null;
    timers: AVRTimer[] = [];
    running: boolean = false;
    pinStates: Record<string, boolean> = {};
    currentWires: any[] = [];
    instances: Map<string, BaseComponent> = new Map();
    lastTime: number = 0;
    statusInterval: any;
    pinsChanged: boolean = true;
    boardId: string;
    private serialBaudRate: number = 9600;
    private serialByteBudget: number = 0;
    private readonly onStateUpdate: (state: any) => void;
    private readonly onByteTransmitCb?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    private i2sState = new Map<string, { bclkLast: boolean; wsLast: boolean; shiftBuf: number; bitCount: number }>();

    constructor(
        hexData: string,
        componentsDef: any[],
        wiresDef: any[],
        onStateUpdate: (state: any) => void,
        options: AVRRunnerOptions = {}
    ) {
        this.currentWires = wiresDef || [];
        this.onStateUpdate = onStateUpdate;
        this.onByteTransmitCb = options.onByteTransmit;
        const fallbackBoard = (componentsDef || []).find((c: any) => /(arduino|esp32|stm32|rp2040|pico)/i.test(String(c.type || '')));
        this.boardId = options.boardId || fallbackBoard?.id || 'wokwi-arduino-uno_0';
        this.setSerialBaudRate(options.serialBaudRate ?? 9600);

        // Setup memory and CPU
        const program = new Uint16Array(32768);
        const { data } = parse(hexData);
        const u8 = new Uint8Array(program.buffer);
        u8.set(data);

        this.cpu = new CPU(program, 0x2200);

        this.timers = [
            new AVRTimer(this.cpu, timer0Config),
            new AVRTimer(this.cpu, timer1Config),
            new AVRTimer(this.cpu, timer2Config)
        ];

        this.adc = new AVRADC(this.cpu, adcConfig);

        this.usart = new AVRUSART(this.cpu, usart0Config, 16e6);
        this.usart.onByteTransmit = (value) => {
            const char = String.fromCharCode(value);
            this.pulseBoardLed('1');
            if (this.onByteTransmitCb) {
                this.onByteTransmitCb({ boardId: this.boardId, value, char, source: 'uart0' });
            } else {
                this.onStateUpdate({ type: 'serial', data: char, value, boardId: this.boardId, source: 'uart0' });
            }
        };

        this.twi = new AVRTWI(this.cpu, twiConfig, 16e6);
        this.spi = new AVRSPI(this.cpu, spiConfig, 16e6);

        this.buildNetlist();

        this.portB = new AVRIOPort(this.cpu, portBConfig);
        this.portC = new AVRIOPort(this.cpu, portCConfig);
        this.portD = new AVRIOPort(this.cpu, portDConfig);

        // Instantiate components
        (componentsDef || []).forEach(cDef => {
            const LogicClass = LOGIC_REGISTRY[cDef.type];
            if (LogicClass) {
                const pins = COMPONENT_PINS[cDef.type] || [{ id: 'A' }, { id: 'K' }, { id: 'GND' }, { id: 'VSS' }];
                const manifest = { type: cDef.type, attrs: cDef.attrs || {}, pins };
                const inst = new LogicClass(cDef.id, manifest);
                if (cDef.attrs) inst.state = { ...inst.state, ...cDef.attrs };
                this.instances.set(cDef.id, inst);
            }
        });

        // Setup I2C Hooks bridging AVRTWI events to BaseComponents
        class TWIAdapter {
            // Track the addressed slave across the read transaction
            private activeSlave: BaseComponent | null = null;

            constructor(private twi: AVRTWI, private instances: Map<string, BaseComponent>) { }

            start(repeated: boolean) {
                this.twi.completeStart();
            }

            stop() {
                const instArray = Array.from(this.instances.values());
                for (const inst of instArray) {
                    if (inst.onI2CStop) {
                        inst.onI2CStop();
                    }
                }
                this.activeSlave = null;
                this.twi.completeStop();
            }

            connectToSlave(addr: number, write: boolean) {
                const instArray = Array.from(this.instances.values());
                let ack = false;
                this.activeSlave = null;
                for (const inst of instArray) {
                    if (inst.onI2CStart) {
                        if (inst.onI2CStart(addr, !write)) { // write here in avr8js is actually the exact R/W bit. "write" true means bit is 0
                            ack = true;
                            if (!this.activeSlave) this.activeSlave = inst; // remember first ACKing slave
                        }
                    }
                }
                this.twi.completeConnect(ack);
            }

            writeByte(value: number) {
                const instArray = Array.from(this.instances.values());
                let handled = false;
                for (const inst of instArray) {
                    if (inst.onI2CByte) {
                        if (inst.onI2CByte(-1, value)) {
                            handled = true;
                        }
                    }
                }
                this.twi.completeWrite(handled);
            }

            readByte(ack: boolean) {
                // Ask the currently addressed slave for the next byte.
                // Components expose this via onI2CReadByte() or readByte().
                let byte = 0xFF;
                if (this.activeSlave) {
                    const slave = this.activeSlave as any;
                    if (typeof slave.onI2CReadByte === 'function') {
                        byte = slave.onI2CReadByte() & 0xFF;
                    } else if (typeof slave.readByte === 'function') {
                        byte = slave.readByte() & 0xFF;
                    }
                }
                this.twi.completeRead(byte);
            }
        }

        this.twi.eventHandler = new TWIAdapter(this.twi, this.instances);

        // Setup SPI Hooks bridging AVRSPI to BaseComponents
        this.spi.onByte = (value: number) => {
            const instArray = Array.from(this.instances.values());
            let returnByte = 0xFF; // Default MISO if nothing responds

            const unoId = this.boardId;

            if (unoId) {
                const misoNet = this.pinToNet.get(`${unoId}:12`);
                if (misoNet !== undefined) {
                    // 1. Direct Loopback (MISO connected to MOSI)
                    if (misoNet === this.pinToNet.get(`${unoId}:11`)) {
                        returnByte = value;
                    }
                    // 2. MISO connected to SCK (Clock pulses)
                    else if (misoNet === this.pinToNet.get(`${unoId}:13`)) {
                        returnByte = 0xAA; // Arbitrary pattern to show clock signal picked up
                    }
                    // 3. MISO connected to any other driven Pin (like 10/SS)
                    else {
                        // Check if the net is currently driven HIGH by another pin
                        let drivenHigh = false;
                        for (const [p, net] of this.pinToNet) {
                            if (net === misoNet && !p.endsWith(':12')) {
                                const [compId, pinId] = p.split(':');
                                if (compId === unoId && this.pinStates[pinId]) {
                                    drivenHigh = true;
                                    break;
                                }
                            }
                        }
                        returnByte = drivenHigh ? 0xFF : 0x00;
                    }
                }
            }

            for (const inst of instArray) {
                if (inst.onSPIByte && this.isSPISelected(inst)) {
                    const res = inst.onSPIByte(value);
                    if (res !== undefined) {
                        returnByte = res;
                    }
                }
            }

            // The SPI peripheral needs to be told when the transfer is physically complete 
            // based on the clock divider speed.
            this.cpu!.addClockEvent(() => {
                this.spi!.completeTransfer(returnByte);
            }, this.spi!.transferCycles);
        };

        // Setup IO Hooks
        this.setupHooks();

        this.running = true;
        this.lastTime = performance.now();
        this.runLoop();

        // 60FPS sync
        this.statusInterval = setInterval(() => {
            if (this.running && this.cpu) {
                const msg: any = { type: 'state' };

                if (this.pinsChanged) {
                    msg.pins = this.pinStates;
                    this.pinsChanged = false;
                }

                if (this.adc) {
                    msg.analog = Array.from(this.adc.channelValues);
                }

                const compStates = Array.from(this.instances.values())
                    .filter(inst => inst.stateChanged)
                    .map(inst => {
                        inst.stateChanged = false;
                        return { id: inst.id, state: inst.getSyncState() };
                    });

                if (compStates.length > 0) {
                    msg.components = compStates;
                }

                // Always send state to ensure continuous plotter timing and analog tracking
                if (!msg.pins) msg.pins = this.pinStates; // Ensure plotData has pins object
                msg.boardId = this.boardId;
                this.onStateUpdate(msg);
            }
        }, 1000 / 60);
    }

    private isBoardArduinoPin(wireCoord: string, targetPin: string): boolean {
        const [compId, compPin] = wireCoord.split(':');
        if (compId !== this.boardId) return false;
        const inst = this.instances.get(compId);
        if (!inst || !inst.type.includes('arduino')) return false;
        return compPin === targetPin || compPin === `D${targetPin}` || compPin === `A${targetPin}`;
    }

    private pulseBoardLed(pinId: '0' | '1') {
        const boardInst = this.instances.get(this.boardId);
        if (!boardInst || !this.cpu) return;
        boardInst.onPinStateChange(pinId, true, this.cpu.cycles);
    }

    private setupHooks() {
        if (!this.cpu) return;

        // All three GND pins on the Uno (gnd_1, gnd_2, gnd_3) are treated as the same ground net.
        const isArduinoGndPin = (compPin: string) =>
            compPin === 'GND' || /^gnd(_\d+)?$/i.test(compPin);

        const isArduino5VPin = (compPin: string) =>
            compPin === '5V' || compPin === 'VCC';

        const updateOopPin = (arduinoPinStr: string, isHigh: boolean) => {
            const v = isHigh ? 5.0 : 0.0;
            const visitedWires = new Set();

            const traverse = (targetStr: string) => {
                const [compId, compPin] = targetStr.split(':');
                const inst = this.instances.get(compId);
                if (inst) {
                    if (!inst.pins[compPin]) inst.pins[compPin] = { voltage: 0, mode: 'INPUT' };
                    inst.setPinVoltage(compPin, v);

                    if (this.cpu) {
                        inst.onPinStateChange(compPin, isHigh, this.cpu.cycles);
                    }

                    // Dispatch I2S frame events when BCLK/WS pins change
                    this.tickI2S(inst, compId, compPin, isHigh);

                    // Traverse THROUGH passive components like resistors
                    if (inst.type === 'wokwi-resistor') {
                        const otherPin = compPin === 'p1' ? 'p2' : 'p1';
                        inst.setPinVoltage(otherPin, v);
                        const forwardStr = `${compId}:${otherPin}`;

                        // Find downstream wires connected to the other side of the resistor
                        this.currentWires.forEach(w => {
                            if (!visitedWires.has(w) && (w.from === forwardStr || w.to === forwardStr)) {
                                visitedWires.add(w);
                                const nextTarget = w.from === forwardStr ? w.to : w.from;
                                traverse(nextTarget);
                            }
                        });
                    }
                }
            };

            // Ensure that the node we are expanding from is actually the Arduino's pin
            this.currentWires.forEach(w => {
                const isFromArduino = this.isBoardArduinoPin(w.from, arduinoPinStr);
                const isToArduino = this.isBoardArduinoPin(w.to, arduinoPinStr);

                if (isFromArduino || isToArduino) {
                    visitedWires.add(w);
                    const targetStr = isFromArduino ? w.to : w.from;
                    traverse(targetStr);
                }
            });

            // Propagate ground through any wire connected to any Arduino GND pin (gnd_1, gnd_2, gnd_3)
            this.currentWires.forEach(w => {
                const [fromComp, fromPin] = w.from.split(':');
                const [toComp, toPin] = w.to.split(':');
                const fromInst = this.instances.get(fromComp);
                const toInst = this.instances.get(toComp);

                const fromIsArduinoGnd = fromComp === this.boardId && fromInst && fromInst.type.includes('arduino') && isArduinoGndPin(fromPin);
                const toIsArduinoGnd = toComp === this.boardId && toInst && toInst.type.includes('arduino') && isArduinoGndPin(toPin);

                if (fromIsArduinoGnd && toInst) {
                    toInst.setPinVoltage(toPin, 0.0);
                } else if (toIsArduinoGnd && fromInst) {
                    fromInst.setPinVoltage(fromPin, 0.0);
                }

                const fromIsArduino5V = fromComp === this.boardId && fromInst && fromInst.type.includes('arduino') && isArduino5VPin(fromPin);
                const toIsArduino5V = toComp === this.boardId && toInst && toInst.type.includes('arduino') && isArduino5VPin(toPin);

                if (fromIsArduino5V && toInst) {
                    toInst.setPinVoltage(toPin, 5.0);
                } else if (toIsArduino5V && fromInst) {
                    fromInst.setPinVoltage(fromPin, 5.0);
                }
            });

            this.instances.forEach(inst => {
                Object.keys(inst.pins).forEach(pinKey => {
                    const pk = pinKey.toLowerCase();
                    if (pk.startsWith('gnd') || pk === 'vss' || pk === 'k') {
                        inst.setPinVoltage(pinKey, 0.0);
                    }
                });
                if ('5V' in inst.pins) inst.setPinVoltage('5V', 5.0);
            });
        };



        this.updatePhysics = () => {
            const checkPort = (port: AVRIOPort, pinNames: string[]) => {
                pinNames.forEach((pin, i) => {
                    let forcedLow = false;
                    const arduinoPinStr = pin;
                    const visitedWires = new Set();

                    const checkForGnd = (targetStr: string) => {
                        const [compId, compPin] = targetStr.split(':');
                        const inst = this.instances.get(compId);
                        if (inst) {
                            const pk = compPin.toLowerCase();
                            const isGndNode = pk.startsWith('gnd') || pk === 'vss' || pk === 'k';
                            if (inst.getPinVoltage(compPin) === 0 && isGndNode) {
                                forcedLow = true;
                            }
                            if (inst.type === 'wokwi-pushbutton' && inst.state.pressed && !forcedLow) {
                                const otherPin = compPin === '1' ? '2' : '1';
                                const forwardStr = `${compId}:${otherPin}`;
                                this.currentWires.forEach(w => {
                                    if (!visitedWires.has(w) && (w.from === forwardStr || w.to === forwardStr)) {
                                        visitedWires.add(w);
                                        checkForGnd(w.from === forwardStr ? w.to : w.from);
                                    }
                                });
                            }
                            if (inst.type === 'wokwi-resistor' && !forcedLow) {
                                const otherPin = compPin === 'p1' ? 'p2' : 'p1';
                                const forwardStr = `${compId}:${otherPin}`;
                                this.currentWires.forEach(w => {
                                    if (!visitedWires.has(w) && (w.from === forwardStr || w.to === forwardStr)) {
                                        visitedWires.add(w);
                                        checkForGnd(w.from === forwardStr ? w.to : w.from);
                                    }
                                });
                            }
                        }
                    };

                    this.currentWires.forEach(w => {
                        const isFromArduino = this.isBoardArduinoPin(w.from, arduinoPinStr);
                        const isToArduino = this.isBoardArduinoPin(w.to, arduinoPinStr);
                        if (isFromArduino || isToArduino) {
                            visitedWires.add(w);
                            checkForGnd(isFromArduino ? w.to : w.from);
                        }
                    });

                    // Set native input bit. If forced to GND by external circuit, it's false
                    if (port) port.setPin(i, !forcedLow);
                });
            };

            if (this.portB) checkPort(this.portB, UNO_DIGITAL_PINS.slice(8, 14));
            if (this.portD) checkPort(this.portD, UNO_DIGITAL_PINS.slice(0, 8));
            if (this.portC) checkPort(this.portC, UNO_ANALOG_PINS);
        };

        const attachPort = (port: AVRIOPort, pinNames: string[]) => {
            port.addListener((value) => {
                pinNames.forEach((pin, i) => {
                    const isHigh = (value & (1 << i)) !== 0;
                    if (this.pinStates[pin] !== isHigh) {
                        this.pinStates[pin] = isHigh;
                        this.pinsChanged = true;

                        const boardInst = this.instances.get(this.boardId);
                        if (boardInst) {
                            boardInst.onPinStateChange(pin, isHigh, this.cpu!.cycles);
                        }

                        updateOopPin(pin, isHigh);
                    }
                });
            });
        };

        if (this.portB) attachPort(this.portB, UNO_DIGITAL_PINS.slice(8, 14)); // PORTB
        if (this.portD) attachPort(this.portD, UNO_DIGITAL_PINS.slice(0, 8)); // PORTD
        if (this.portC) attachPort(this.portC, UNO_ANALOG_PINS); // PORTC

        // Initialize all hooked pins to LOW on startup so LED components aren't stuck waiting for a toggle
        [...UNO_DIGITAL_PINS, ...UNO_ANALOG_PINS].forEach(pin => {
            this.pinStates[pin] = false;
            updateOopPin(pin, false);
        });
    }

    private runLoop = () => {
        if (!this.running || !this.cpu) return;

        const now = performance.now();
        const deltaTime = now - this.lastTime;

        if (deltaTime > 0) {
            const cyclesToRun = deltaTime * 16000;
            const targetObj = this.cpu.cycles + Math.min(cyclesToRun, 1600000);

            if (this.updatePhysics) this.updatePhysics();

            while (this.cpu.cycles < targetObj && this.running) {
                avrInstruction(this.cpu);
                this.cpu.tick();
            }
            this.lastTime = now;

            // Host/UART receive pacing: bytes per second = baud / 10 (8N1 frame)
            // bytes per ms = baud / 10000. We accumulate fractional budget over time.
            const bytesPerMs = this.serialBaudRate / 10000;
            this.serialByteBudget += deltaTime * bytesPerMs;

            if (this.serialBuffer.length > 0 && this.usart && this.serialByteBudget >= 1) {
                const maxBytes = Math.floor(this.serialByteBudget);
                const toSend = Math.min(maxBytes, this.serialBuffer.length);
                for (let i = 0; i < toSend; i++) {
                    this.usart.writeByte(this.serialBuffer.shift()!);
                }
                this.serialByteBudget -= toSend;
            }

            const instArray = Array.from(this.instances.values());
            instArray.forEach(inst => inst.update(this.cpu!.cycles, this.currentWires, instArray));

            if (this.adc && this.cpu) {
                // Poll analog voltages at ~60Hz or however often runLoop breaks, 
                // but actually runLoop is very frequent (every 1ms)
                for (let i = 0; i < UNO_ANALOG_PINS.length; i++) {
                    const arduinoPin = UNO_ANALOG_PINS[i];
                    let voltage = 0;
                    for (const w of this.currentWires) {
                        const [fromComp, fromPin] = w.from.split(':');
                        const [toComp, toPin] = w.to.split(':');

                        let isConnectedToPin = false;
                        let otherCompId = '';
                        let otherCompPin = '';

                        if (fromComp === this.boardId && (fromPin === arduinoPin || fromPin === `A${i}`)) {
                            isConnectedToPin = true;
                            otherCompId = toComp;
                            otherCompPin = toPin;
                        } else if (toComp === this.boardId && (toPin === arduinoPin || toPin === `A${i}`)) {
                            isConnectedToPin = true;
                            otherCompId = fromComp;
                            otherCompPin = fromPin;
                        }

                        if (isConnectedToPin) {
                            const inst = this.instances.get(otherCompId);
                            if (inst) {
                                voltage = Math.max(voltage, inst.getPinVoltage(otherCompPin));
                            }
                        }
                    }
                    this.adc.channelValues[i] = voltage;
                }
            }
        }

        setTimeout(this.runLoop, 1);
    }

    private serialBuffer: number[] = [];

    serialRx(data: string) {
        for (let i = 0; i < data.length; i++) {
            this.serialBuffer.push(data.charCodeAt(i));
            this.pulseBoardLed('0');
        }
    }

    serialRxByte(value: number) {
        this.serialBuffer.push(value & 0xff);
        this.pulseBoardLed('0');
    }

    setSerialBaudRate(baud: number) {
        const parsed = Number(baud);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.max(300, Math.min(2000000, Math.floor(parsed)));
        this.serialBaudRate = clamped;
    }

    getSerialBaudRate(): number {
        return this.serialBaudRate;
    }

    stop() {
        this.running = false;
        clearInterval(this.statusInterval);
    }

    reset() {
        if (this.cpu) this.cpu.reset();
    }

    // ─── SPI: chip-select awareness ───────────────────────────────────────────
    /**
     * Returns true if the component should receive the current SPI byte.
     * A component is selected when:
     *   • It has no CS/SS pin  (single-slave wiring → always selected), OR
     *   • Its CS/SS pin voltage is < 0.5 V  (active-LOW chip select)
     */
    private isSPISelected(inst: BaseComponent): boolean {
        const csNames = ['cs', 'ce', 'ss', 'ssel', 'nss', 'csn', 'cs_n', 'nce'];
        for (const name of csNames) {
            if (inst.pins[name])             return inst.getPinVoltage(name) < 0.5;
            if (inst.pins[name.toUpperCase()]) return inst.getPinVoltage(name.toUpperCase()) < 0.5;
        }
        return true; // no CS pin → always selected
    }

    // ─── I2S: bit-bang frame assembler ────────────────────────────────────────
    /**
     * Called from the pin-change traversal whenever any component has a pin
     * voltage updated.  If the changed pin is the component's BCLK or WS line
     * (matched by common I2S naming conventions), the assembler clocks one bit
     * into a shift buffer.  Once bitsPerFrame bits have been collected for one
     * channel, onI2SFrame() is called.
     *
     * Left-justified format (no WS-delay):
     *   WS=LOW  → left  channel (channel 0)
     *   WS=HIGH → right channel (channel 1)
     * Data is sampled on the BCLK **rising** edge, MSB first.
     */
    private tickI2S(inst: BaseComponent, compId: string, changedPin: string, isHigh: boolean): void {
        if (!inst.onI2SFrame) return;

        const pin    = changedPin.toLowerCase();
        const isBclk = pin === 'bclk' || pin === 'sck' || pin === 'bit_clk' || pin === 'blck';
        const isWs   = pin === 'ws'   || pin === 'lrck' || pin === 'wsel'   || pin === 'lrc';

        if (!isBclk && !isWs) return;

        if (!this.i2sState.has(compId)) {
            this.i2sState.set(compId, { bclkLast: false, wsLast: false, shiftBuf: 0, bitCount: 0 });
        }
        const state = this.i2sState.get(compId)!;

        if (isWs) {
            if (state.wsLast !== isHigh) {
                // WS edge → end of the current-channel frame
                const bpf = (inst.state?.i2sBitsPerFrame as number | undefined) ?? 16;
                if (state.bitCount >= bpf) {
                    const channel = state.wsLast ? 1 : 0;
                    const sample  = (state.shiftBuf << (32 - bpf)) | 0; // sign-extend
                    inst.onI2SFrame(channel, sample, bpf);
                }
                state.wsLast   = isHigh;
                state.shiftBuf = 0;
                state.bitCount = 0;
            }
            return;
        }

        // BCLK edge
        const rising = isHigh && !state.bclkLast;
        state.bclkLast = isHigh;

        if (rising) {
            // Sample SDATA (accept several common pin names)
            const sdPin = this.findI2SPinName(inst, ['sdata', 'sdin', 'din', 'sd', 'dout', 'data']);
            const bit   = sdPin !== null ? (inst.getPinVoltage(sdPin) > 0.5 ? 1 : 0) : 0;

            const bpf = (inst.state?.i2sBitsPerFrame as number | undefined) ?? 16;
            state.shiftBuf = ((state.shiftBuf << 1) | bit) >>> 0;
            state.bitCount++;

            if (state.bitCount >= bpf) {
                const channel = state.wsLast ? 1 : 0;
                const sample  = (state.shiftBuf << (32 - bpf)) | 0;
                inst.onI2SFrame(channel, sample, bpf);
                state.shiftBuf = 0;
                state.bitCount = 0;
            }
        }
    }

    /** Finds the first existing pin on `inst` from a list of candidate names
     *  (case-insensitive, lower then UPPER checked). */
    private findI2SPinName(inst: BaseComponent, candidates: string[]): string | null {
        for (const name of candidates) {
            if (inst.pins[name])               return name;
            if (inst.pins[name.toUpperCase()]) return name.toUpperCase();
        }
        return null;
    }

    private pinToNet = new Map<string, number>();

    private buildNetlist() {
        const adj = new Map<string, string[]>();

        // Add wires to adjacency list
        for (const wire of this.currentWires) {
            if (!adj.has(wire.from)) adj.set(wire.from, []);
            if (!adj.has(wire.to)) adj.set(wire.to, []);
            adj.get(wire.from)!.push(wire.to);
            adj.get(wire.to)!.push(wire.from);
        }

        // Add resistor bridges to adjacency list
        for (const [id, inst] of this.instances) {
            if (inst.type === 'wokwi-resistor') {
                const p1 = `${id}:p1`;
                const p2 = `${id}:p2`;
                if (!adj.has(p1)) adj.set(p1, []);
                if (!adj.has(p2)) adj.set(p2, []);
                adj.get(p1)!.push(p2);
                adj.get(p2)!.push(p1);
            }
        }

        const visited = new Set<string>();
        let currentNet = 0;

        for (const startNode of adj.keys()) {
            if (!visited.has(startNode)) {
                const queue = [startNode];
                visited.add(startNode);
                while (queue.length > 0) {
                    const node = queue.shift()!;
                    this.pinToNet.set(node, currentNet);

                    // Also set aliases (D11, 11 etc)
                    const parts = node.split(':');
                    if (parts.length === 2) {
                        const compId = parts[0];
                        const pinId = parts[1];
                        if (!pinId.startsWith('D') && !pinId.startsWith('A') && /^\d+$/.test(pinId)) {
                            this.pinToNet.set(`${compId}:D${pinId}`, currentNet);
                        } else if (pinId.startsWith('D')) {
                            this.pinToNet.set(`${compId}:${pinId.substring(1)}`, currentNet);
                        }
                    }

                    for (const neighbor of adj.get(node) || []) {
                        if (!visited.has(neighbor)) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    }
                }
                currentNet++;
            }
        }
    }

    private arePinsConnected(pinA: string, pinB: string): boolean {
        const netA = this.pinToNet.get(pinA);
        const netB = this.pinToNet.get(pinB);
        return netA !== undefined && netA === netB;
    }
}

export class RP2040Runner implements BoardRunner {
    cpu: RP2040 | null = null;
    running: boolean = false;
    pinStates: Record<string, boolean> = {};
    currentWires: any[] = [];
    instances: Map<string, BaseComponent> = new Map();
    lastTime: number = 0;
    statusInterval: any;
    pinsChanged: boolean = true;
    boardId: string;
    private serialBaudRate: number = 115200;
    private serialByteBudget: number = 0;
    private readonly onStateUpdate: (state: any) => void;
    private readonly onByteTransmitCb?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    private readonly firmwareHex: string;
    private serialBuffer: number[] = [];
    private activeUartIndex: number = 0;
    private usbCdc: USBCDC | null = null;
    private usbCdcReady: boolean = false;
    private gpioUnsubscribers: Array<() => boolean> = [];
    private hasFaulted: boolean = false;
    private bootromLoaded: boolean = false;
    private cpuCyclesAtStart: number = 0;
    private readonly debugEnabled: boolean;
    private readonly debugIntervalMs: number;
    private debugLastEmitAt: number = 0;
    private debugStepCount: number = 0;
    private debugSerialTxBytes: number = 0;
    private debugSerialRxBytes: number = 0;
    private debugGpioTransitions: number = 0;
    private debugLastGpioPin: string = '';
    private debugLastPc: number = 0;
    private debugPcStallTicks: number = 0;
    private lastSerialByte: number = -1;
    private lastSerialSource: number = -1;
    private lastSerialEmitAt: number = 0;
    private lastUsbSerialAt: number = 0;
    private lowPcAliasCandidate: number = -1;
    private lowPcAliasRepeatCount: number = 0;
    private entryInfo: RP2040EntryInfo | null = null;
    private static readonly FAULT_GRACE_CYCLES = 6_000_000; // ~48ms simulated @ 125MHz – covers bootrom + MicroPython init
    private static readonly SERIAL_DEDUP_WINDOW_MS = 2;
    private static readonly USB_SERIAL_PREFER_WINDOW_MS = 250;

    constructor(
        hexData: string,
        componentsDef: any[],
        wiresDef: any[],
        onStateUpdate: (state: any) => void,
        options: AVRRunnerOptions = {}
    ) {
        this.currentWires = wiresDef || [];
        this.onStateUpdate = onStateUpdate;
        this.onByteTransmitCb = options.onByteTransmit;
        this.firmwareHex = String(hexData || '');

        const fallbackBoard = (componentsDef || []).find((c: any) => /(rp2040|pico)/i.test(String(c.type || '')));
        this.boardId = options.boardId || fallbackBoard?.id || 'wokwi-raspberry-pi-pico_0';
        this.setSerialBaudRate(options.serialBaudRate ?? 115200);
        this.debugEnabled = options.debugEnabled !== false;
        this.debugIntervalMs = Math.max(150, Number(options.debugIntervalMs || 800));

        this.cpu = new RP2040();
        this.patchClockSelectedReads();
        this.cpu.loadBootrom(bootromB1);
        this.cpu.logger = new ConsoleLogger(LogLevel.Error, true);
        this.bootromLoaded = true;
        this.entryInfo = loadRP2040Firmware(this.cpu, this.firmwareHex);
        this.cpuCyclesAtStart = this.cpu.core.cycles;

        (componentsDef || []).forEach((cDef) => {
            const LogicClass = LOGIC_REGISTRY[cDef.type];
            if (LogicClass) {
                const pins = COMPONENT_PINS[cDef.type] || [{ id: 'A' }, { id: 'K' }, { id: 'GND' }, { id: 'VSS' }];
                const manifest = { type: cDef.type, attrs: cDef.attrs || {}, pins };
                const inst = new LogicClass(cDef.id, manifest);
                if (cDef.attrs) inst.state = { ...inst.state, ...cDef.attrs };
                this.instances.set(cDef.id, inst);
            }
        });

        this.attachGPIOListeners();
        this.attachUART();
        this.attachUSBSerial();

        // Seed default pin values as LOW so dependent components can initialize.
        for (let gp = 0; gp <= 28; gp++) {
            const pin = `GP${gp}`;
            this.pinStates[pin] = false;
            this.propagateBoardPin(pin, false);
        }

        this.running = true;
        this.lastTime = performance.now();
        this.emitDebugSnapshot('start', this.lastTime, true);
        this.runLoop();

        this.statusInterval = setInterval(() => {
            if (this.running && this.cpu) {
                const msg: any = { type: 'state', boardId: this.boardId };
                if (this.pinsChanged) {
                    msg.pins = this.pinStates;
                    this.pinsChanged = false;
                }

                const compStates = Array.from(this.instances.values())
                    .filter((inst) => inst.stateChanged)
                    .map((inst) => {
                        inst.stateChanged = false;
                        return { id: inst.id, state: inst.getSyncState() };
                    });

                if (compStates.length > 0) {
                    msg.components = compStates;
                }

                if (!msg.pins) msg.pins = this.pinStates;
                this.onStateUpdate(msg);
            }
        }, 1000 / 60);
    }

    private patchClockSelectedReads() {
        if (!this.cpu) return;

        try {
            const clocksPeripheral: any = this.cpu.findPeripheral(RP2040_CLOCKS_BASE);
            if (!clocksPeripheral || typeof clocksPeripheral.readUint32 !== 'function') return;

            const originalReadUint32 = clocksPeripheral.readUint32.bind(clocksPeripheral);
            const originalWriteUint32 = typeof clocksPeripheral.writeUint32 === 'function'
                ? clocksPeripheral.writeUint32.bind(clocksPeripheral)
                : null;
            const ctrlShadow: Record<number, number> = {
                [RP2040_CLOCKS_CLK_REF_CTRL_OFFSET]: 0,
                [RP2040_CLOCKS_CLK_SYS_CTRL_OFFSET]: 0,
            };

            clocksPeripheral.readUint32 = (offset: number) => {
                if (offset === RP2040_CLOCKS_CLK_REF_CTRL_OFFSET || offset === RP2040_CLOCKS_CLK_SYS_CTRL_OFFSET) {
                    return ctrlShadow[offset] >>> 0;
                }

                if (offset === RP2040_CLOCKS_CLK_REF_SELECTED_OFFSET || offset === RP2040_CLOCKS_CLK_SYS_SELECTED_OFFSET) {
                    // Emulate glitchless selected source bits from the corresponding CTRL source field.
                    // This unblocks startup loops used by Arduino-Pico and MicroPython clock init.
                    const ctrlOffset = offset === RP2040_CLOCKS_CLK_REF_SELECTED_OFFSET
                        ? RP2040_CLOCKS_CLK_REF_CTRL_OFFSET
                        : RP2040_CLOCKS_CLK_SYS_CTRL_OFFSET;
                    const srcMask = offset === RP2040_CLOCKS_CLK_REF_SELECTED_OFFSET ? 0x3 : 0x1;
                    const src = (ctrlShadow[ctrlOffset] >>> 0) & srcMask;
                    return (1 << src) >>> 0;
                }
                return originalReadUint32(offset);
            };

            clocksPeripheral.writeUint32 = (offset: number, value: number) => {
                if (offset === RP2040_CLOCKS_CLK_REF_CTRL_OFFSET || offset === RP2040_CLOCKS_CLK_SYS_CTRL_OFFSET) {
                    ctrlShadow[offset] = value >>> 0;
                    return;
                }
                if (originalWriteUint32) {
                    originalWriteUint32(offset, value);
                }
            };
        } catch {
            // Non-fatal: if this fails we keep default rp2040js behavior.
        }
    }

    private isExecutableAddress(addr: number): boolean {
        const pc = (addr >>> 0);
        const flashEnd = (RP2040_FLASH_BASE + this.cpu!.flash.length) >>> 0;
        const flashNoCacheEnd = (RP2040_XIP_NOCACHE_BASE + this.cpu!.flash.length) >>> 0;
        const sramEnd = (RP2040_SRAM_BASE + this.cpu!.sram.length) >>> 0;

        if (this.bootromLoaded && pc >= RP2040_BOOTROM_BASE && pc < (RP2040_BOOTROM_BASE + RP2040_BOOTROM_SIZE)) return true;
        if (pc >= RP2040_FLASH_BASE && pc < flashEnd) return true;
        if (pc >= RP2040_XIP_NOCACHE_BASE && pc < flashNoCacheEnd) return true;
        if (pc >= RP2040_SRAM_BASE && pc < sramEnd) return true;
        return false;
    }

    private faultAndStop(reason: string, pc: number) {
        if (this.hasFaulted) return;
        this.hasFaulted = true;
        this.running = false;
        clearInterval(this.statusInterval);
        this.emitDebugSnapshot('fault', performance.now(), true, reason, pc >>> 0);
        this.onStateUpdate({
            type: 'fault',
            boardId: this.boardId,
            reason,
            pc: pc >>> 0,
        });
    }

    private emitDebugSnapshot(
        reason: 'start' | 'tick' | 'fault' | 'reset' = 'tick',
        now = performance.now(),
        force = false,
        faultReason = '',
        faultPc?: number
    ) {
        if (!this.debugEnabled || !this.cpu) return;
        if (!force && (now - this.debugLastEmitAt) < this.debugIntervalMs) return;

        const pc = this.cpu.core.PC >>> 0;
        if (pc === this.debugLastPc) this.debugPcStallTicks++;
        else this.debugPcStallTicks = 0;
        this.debugLastPc = pc;

        const firstLed = Array.from(this.instances.values()).find((inst) => inst.type === 'wokwi-led');
        const ledAnodeV = firstLed ? Number(firstLed.getPinVoltage('A') || 0) : null;
        const ledCathodeV = firstLed ? Number(firstLed.getPinVoltage('K') || 0) : null;
        const ledDeltaV = (ledAnodeV !== null && ledCathodeV !== null)
            ? Number((ledAnodeV - ledCathodeV).toFixed(3))
            : null;
        const ledOn = firstLed ? !!firstLed.state?.illuminated : null;
        const highPins = Object.keys(this.pinStates)
            .filter((pin) => !!this.pinStates[pin])
            .sort((a, b) => Number(a.replace('GP', '')) - Number(b.replace('GP', '')));
        const pinBitmap = Array.from({ length: 29 }, (_, idx) => (this.pinStates[`GP${idx}`] ? '1' : '0')).join('');

        const payload = {
            type: 'debug',
            boardId: this.boardId,
            category: 'rp2040-runtime',
            reason,
            metrics: {
                running: this.running,
                faulted: this.hasFaulted,
                pc,
                sp: this.cpu.core.SP >>> 0,
                cycles: this.cpu.core.cycles >>> 0,
                activeUart: this.activeUartIndex,
                serialTxBytes: this.debugSerialTxBytes,
                serialRxBytes: this.debugSerialRxBytes,
                usbCdcReady: this.usbCdcReady,
                serialInputQueue: this.serialBuffer.length,
                stepCount: this.debugStepCount,
                gpioTransitions: this.debugGpioTransitions,
                lastGpioPin: this.debugLastGpioPin,
                gp20: !!this.pinStates.GP20,
                gp25: !!this.pinStates.GP25,
                highPins,
                pinBitmap,
                ledId: firstLed?.id || '',
                ledOn,
                ledAnodeV,
                ledCathodeV,
                ledDeltaV,
                pcStallTicks: this.debugPcStallTicks,
                entry: this.entryInfo,
            },
            fault: faultReason
                ? {
                    reason: faultReason,
                    pc: Number.isFinite(Number(faultPc)) ? (Number(faultPc) >>> 0) : pc,
                }
                : undefined,
        };

        this.debugLastEmitAt = now;
        this.onStateUpdate(payload);
    }

    private rebaseProgramCounterAlias() {
        if (!this.cpu) return;
        const pc = this.cpu.core.PC >>> 0;
        // Some firmware images carry flash-relative addresses in branch tables.
        // Map plausible flash aliases into XIP immediately, and for low ROM-range
        // addresses only recover after detecting a sustained local PC stall.
        if (!(pc > 0 && pc < this.cpu.flash.length)) {
            this.lowPcAliasCandidate = -1;
            this.lowPcAliasRepeatCount = 0;
            return;
        }

        const flashIndex = pc & ~1;
        const hasFlashData = flashIndex + 1 < this.cpu.flash.length
            && (this.cpu.flash[flashIndex] !== 0xff || this.cpu.flash[flashIndex + 1] !== 0xff);
        if (!hasFlashData) {
            this.lowPcAliasCandidate = -1;
            this.lowPcAliasRepeatCount = 0;
            return;
        }

        const rebased = ((RP2040_FLASH_BASE + pc) | 1) >>> 0;
        const inBootromRange = this.bootromLoaded && pc < RP2040_BOOTROM_SIZE;
        if (!inBootromRange) {
            this.lowPcAliasCandidate = -1;
            this.lowPcAliasRepeatCount = 0;
            this.cpu.core.BXWritePC(rebased);
            return;
        }

        // Boot ROM can be entered legitimately. Only force alias recovery when
        // execution is visibly stuck at the same low PC for many consecutive steps.
        if (this.lowPcAliasCandidate === pc) {
            this.lowPcAliasRepeatCount += 1;
        } else {
            this.lowPcAliasCandidate = pc;
            this.lowPcAliasRepeatCount = 0;
        }

        if (this.lowPcAliasRepeatCount >= 4096) {
            this.cpu.core.BXWritePC(rebased);
            this.lowPcAliasRepeatCount = 0;
        }
    }

    private attachUART() {
        if (!this.cpu?.uart) return;

        const bindUart = (uartIndex: 0 | 1) => {
            const uart = this.cpu?.uart?.[uartIndex];
            if (!uart) return;

            uart.onByte = (value: number) => {
                this.emitSerialByte(value, uartIndex);
            };
        };

        bindUart(0);
        bindUart(1);
    }

    private attachUSBSerial() {
        if (!this.cpu?.usbCtrl) return;

        const cdc = new USBCDC(this.cpu.usbCtrl);
        this.usbCdc = cdc;
        this.usbCdcReady = false;

        cdc.onDeviceConnected = () => {
            this.usbCdcReady = true;
        };

        cdc.onSerialData = (buffer: Uint8Array) => {
            for (let i = 0; i < buffer.length; i++) {
                this.emitSerialByte(buffer[i] & 0xff, 2);
            }
        };
    }

    private emitSerialByte(value: number, source: number) {
        const byte = value & 0xff;
        const char = String.fromCharCode(byte);
        const now = performance.now();

        if (source === 2) {
            this.lastUsbSerialAt = now;
        } else if (
            this.usbCdcReady
            && (now - this.lastUsbSerialAt) <= RP2040Runner.USB_SERIAL_PREFER_WINDOW_MS
        ) {
            // When USB CDC is actively producing serial, suppress near-concurrent
            // UART echoes to avoid doubled/garbled monitor output.
            return;
        }

        this.activeUartIndex = source;

        // MicroPython UF2 can emit identical bytes over UART and USB CDC nearly
        // simultaneously. Drop the second copy to keep the monitor readable.
        if (
            source !== this.lastSerialSource
            && byte === this.lastSerialByte
            && (now - this.lastSerialEmitAt) <= RP2040Runner.SERIAL_DEDUP_WINDOW_MS
        ) {
            this.lastSerialSource = source;
            this.lastSerialEmitAt = now;
            return;
        }

        this.lastSerialByte = byte;
        this.lastSerialSource = source;
        this.lastSerialEmitAt = now;
        this.debugSerialTxBytes += 1;
        this.pulseBoardUartLed('GP0');
        const sourceLabel = source === 2 ? 'usb' : source === 1 ? 'uart1' : 'uart0';

        if (this.onByteTransmitCb) {
            this.onByteTransmitCb({ boardId: this.boardId, value: byte, char, source: sourceLabel });
        } else {
            this.onStateUpdate({ type: 'serial', data: char, value: byte, boardId: this.boardId, source: sourceLabel });
        }
    }

    private pulseBoardUartLed(pinId: 'GP0' | 'GP1') {
        const boardInst = this.instances.get(this.boardId);
        if (!boardInst || !this.cpu) return;
        boardInst.onPinStateChange(pinId, true, this.cpu.core.cycles);
        setTimeout(() => {
            if (!this.cpu) return;
            boardInst.onPinStateChange(pinId, false, this.cpu.core.cycles);
        }, 40);
    }

    private normalizeToGpPin(pinId: string): string {
        const raw = String(pinId || '').toUpperCase();
        if (/^GP\d+$/.test(raw)) return raw;
        if (/^GPIO\d+$/.test(raw)) return `GP${raw.slice(4)}`;
        if (/^D\d+$/.test(raw)) return `GP${raw.slice(1)}`;
        if (/^\d+$/.test(raw)) return `GP${raw}`;
        return raw;
    }

    private boardPinAliases(pinId: string): string[] {
        const gp = this.normalizeToGpPin(pinId);
        const match = /^GP(\d+)$/.exec(gp);
        if (!match) return [pinId, gp];
        const n = match[1];
        return [pinId, gp, `GPIO${n}`, `D${n}`, n];
    }

    private isBoardPin(wireCoord: string, targetGpPin: string): boolean {
        const [compId, compPin] = wireCoord.split(':');
        if (compId !== this.boardId) return false;
        const norm = this.normalizeToGpPin(compPin);
        return this.boardPinAliases(targetGpPin).includes(norm) || this.boardPinAliases(targetGpPin).includes(compPin);
    }

    private traversePassive(inst: BaseComponent, compId: string, pinId: string, voltage: number, visit: (target: string) => void) {
        if (inst.type === 'wokwi-resistor') {
            const otherPin = pinId === 'p1' ? 'p2' : pinId === 'p2' ? 'p1' : null;
            if (!otherPin) return;
            inst.setPinVoltage(otherPin, voltage);
            visit(`${compId}:${otherPin}`);
        } else if (inst.type === 'wokwi-pushbutton' && inst.state?.pressed) {
            const otherPin = pinId === '1' ? '2' : pinId === '2' ? '1' : null;
            if (!otherPin) return;
            inst.setPinVoltage(otherPin, voltage);
            visit(`${compId}:${otherPin}`);
        }
    }

    private propagateBoardPin(gpPin: string, isHigh: boolean) {
        const voltage = isHigh ? 3.3 : 0.0;
        const visitedEdges = new Set<string>();

        const visitNode = (node: string) => {
            const [compId, compPin] = node.split(':');
            const inst = this.instances.get(compId);
            if (!inst) return;
            if (!inst.pins[compPin]) inst.pins[compPin] = { voltage: 0, mode: 'INPUT' };
            inst.setPinVoltage(compPin, voltage);
            if (this.cpu) inst.onPinStateChange(compPin, isHigh, this.cpu.core.cycles);

            this.traversePassive(inst, compId, compPin, voltage, (forwardNode) => {
                for (const w of this.currentWires) {
                    const edgeKey = `${w.from}|${w.to}`;
                    if (visitedEdges.has(edgeKey)) continue;
                    if (w.from === forwardNode || w.to === forwardNode) {
                        visitedEdges.add(edgeKey);
                        visitNode(w.from === forwardNode ? w.to : w.from);
                    }
                }
            });
        };

        for (const wire of this.currentWires) {
            const edgeKey = `${wire.from}|${wire.to}`;
            const fromBoard = this.isBoardPin(wire.from, gpPin);
            const toBoard = this.isBoardPin(wire.to, gpPin);
            if (!fromBoard && !toBoard) continue;
            visitedEdges.add(edgeKey);
            visitNode(fromBoard ? wire.to : wire.from);
        }

        // Drive fixed board rails.
        this.instances.forEach((inst) => {
            Object.keys(inst.pins).forEach((pinKey) => {
                const upper = pinKey.toUpperCase();
                if (upper === 'GND' || upper === 'AGND' || upper === 'VSS' || upper.startsWith('GND_') || upper === 'K') {
                    inst.setPinVoltage(pinKey, 0.0);
                }
                if (upper === '3V3' || upper === 'VCC') {
                    inst.setPinVoltage(pinKey, 3.3);
                }
            });
        });
    }

    private attachGPIOListeners() {
        if (!this.cpu) return;

        for (let gp = 0; gp <= 28; gp++) {
            const pinName = `GP${gp}`;
            const unsubscribe = this.cpu.gpio[gp].addListener((state: GPIOPinState) => {
                const isHigh = state === GPIOPinState.High;
                if (this.pinStates[pinName] !== isHigh) {
                    this.pinStates[pinName] = isHigh;
                    this.pinsChanged = true;
                    this.debugGpioTransitions += 1;
                    this.debugLastGpioPin = pinName;
                    const boardInst = this.instances.get(this.boardId);
                    if (boardInst && this.cpu) {
                        boardInst.onPinStateChange(pinName, isHigh, this.cpu.core.cycles);
                    }
                    this.propagateBoardPin(pinName, isHigh);
                }
            });
            this.gpioUnsubscribers.push(unsubscribe);
        }
    }

    private updateGPIOInputsFromCircuit() {
        if (!this.cpu) return;

        for (let gp = 0; gp <= 28; gp++) {
            const gpPin = `GP${gp}`;
            let observedVoltage = 0;

            for (const wire of this.currentWires) {
                let otherEndpoint: string | null = null;
                if (this.isBoardPin(wire.from, gpPin)) otherEndpoint = wire.to;
                if (this.isBoardPin(wire.to, gpPin)) otherEndpoint = wire.from;
                if (!otherEndpoint) continue;

                const [compId, compPin] = otherEndpoint.split(':');
                const inst = this.instances.get(compId);
                if (!inst) continue;
                observedVoltage = Math.max(observedVoltage, inst.getPinVoltage(compPin));
            }

            this.cpu.gpio[gp].setInputValue(observedVoltage > 1.65);
        }
    }

    private runLoop = () => {
        if (!this.running || !this.cpu) return;

        this.rebaseProgramCounterAlias();
        const currentPc = this.cpu.core.PC >>> 0;
        const cyclesSinceStart = (this.cpu.core.cycles - this.cpuCyclesAtStart) >>> 0;
        const pastGracePeriod = cyclesSinceStart > RP2040Runner.FAULT_GRACE_CYCLES;
        if (pastGracePeriod && !this.isExecutableAddress(currentPc)) {
            this.faultAndStop('Invalid RP2040 program counter', currentPc);
            return;
        }

        const now = performance.now();
        const deltaTime = now - this.lastTime;

        if (deltaTime > 0) {
            this.updateGPIOInputsFromCircuit();

            // Keep RP2040 stepping bounded to avoid worker starvation on large circuits.
            // Use 50 000 steps/ms so MicroPython boots in ~2.5 s real time.
            const steps = Math.max(1000, Math.min(500_000, Math.floor(deltaTime * 50_000)));
            for (let i = 0; i < steps && this.running && this.cpu; i++) {
                try {
                    this.cpu.step();
                    this.debugStepCount += 1;
                } catch (err: any) {
                    const message = String(err?.message || err || 'RP2040 execution error');
                    this.faultAndStop(message, this.cpu.core.PC >>> 0);
                    break;
                }
                this.rebaseProgramCounterAlias();

                const stepPc = this.cpu.core.PC >>> 0;
                const cyclesSinceStart = (this.cpu.core.cycles - this.cpuCyclesAtStart) >>> 0;
                const pastGrace = cyclesSinceStart > RP2040Runner.FAULT_GRACE_CYCLES;
                if (pastGrace && !this.isExecutableAddress(stepPc)) {
                    this.faultAndStop('Execution jumped outside valid memory', stepPc);
                    break;
                }
            }

            if (!this.running || !this.cpu) return;

            this.lastTime = now;

            const bytesPerMs = this.serialBaudRate / 10000;
            this.serialByteBudget += deltaTime * bytesPerMs;

            const uart0 = this.cpu.uart[0];
            const uart1 = this.cpu.uart[1];
            const preferredUart = this.activeUartIndex === 1
                ? (uart1 || uart0)
                : (uart0 || uart1);
            const preferUsbIngress = !!(this.usbCdc && this.usbCdcReady && this.activeUartIndex === 2);
            if (this.serialBuffer.length > 0 && this.serialByteBudget >= 1) {
                const maxBytes = Math.floor(this.serialByteBudget);
                let sent = 0;

                const hasRxCapacity = (uart: any) => {
                    if (!uart || typeof uart.feedByte !== 'function') return false;
                    const fifo = (uart as any).rxFIFO;
                    if (fifo && typeof fifo.full === 'boolean') {
                        return !fifo.full;
                    }
                    return true;
                };

                for (let i = 0; i < maxBytes && this.serialBuffer.length > 0; i++) {
                    const byte = this.serialBuffer[0]!;
                    const fed = new Set<any>();
                    const feed = (uart: any, optional: boolean) => {
                        if (!uart || typeof uart.feedByte !== 'function' || fed.has(uart)) {
                            return false;
                        }

                        const fifo = (uart as any).rxFIFO;
                        if (fifo && typeof fifo.full === 'boolean' && fifo.full) {
                            return optional;
                        }

                        uart.feedByte(byte);
                        fed.add(uart);
                        return true;
                    };

                    let delivered = false;

                    if (preferUsbIngress) {
                        try {
                            this.usbCdc!.sendSerialByte(byte);
                            delivered = true;
                        } catch {
                            delivered = false;
                        }
                    } else {
                        // Route host input into one ingress target to avoid duplicate
                        // command delivery when USB CDC and UART are both active.
                        if (preferredUart && hasRxCapacity(preferredUart)) {
                            delivered = feed(preferredUart, false);
                        }

                        if (!delivered && this.usbCdc && this.usbCdcReady) {
                            try {
                                this.usbCdc.sendSerialByte(byte);
                                delivered = true;
                            } catch {
                                delivered = false;
                            }
                        }
                    }

                    if (!delivered) {
                        break;
                    }

                    this.serialBuffer.shift();
                    sent += 1;
                }

                this.serialByteBudget -= sent;
            }

            const instArray = Array.from(this.instances.values());
            instArray.forEach((inst) => inst.update(this.cpu!.core.cycles, this.currentWires, instArray));

            this.emitDebugSnapshot('tick', now);
        }

        setTimeout(this.runLoop, 0);
    };

    serialRx(data: string) {
        for (let i = 0; i < data.length; i++) {
            this.serialBuffer.push(data.charCodeAt(i) & 0xff);
            this.debugSerialRxBytes += 1;
        }
        this.pulseBoardUartLed('GP1');
    }

    serialRxByte(value: number) {
        this.serialBuffer.push(value & 0xff);
        this.debugSerialRxBytes += 1;
        this.pulseBoardUartLed('GP1');
    }

    setSerialBaudRate(baud: number) {
        const parsed = Number(baud);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.max(300, Math.min(3000000, Math.floor(parsed)));
        this.serialBaudRate = clamped;
    }

    getSerialBaudRate(): number {
        return this.serialBaudRate;
    }

    reset() {
        if (!this.cpu) return;
        this.cpu.reset();
        this.cpu.loadBootrom(bootromB1);
        this.bootromLoaded = true;
        this.entryInfo = loadRP2040Firmware(this.cpu, this.firmwareHex);
        this.serialBuffer = [];
        this.serialByteBudget = 0;
        this.activeUartIndex = 0;
        this.usbCdc = null;
        this.usbCdcReady = false;
        this.debugLastEmitAt = 0;
        this.debugStepCount = 0;
        this.debugSerialTxBytes = 0;
        this.debugSerialRxBytes = 0;
        this.debugGpioTransitions = 0;
        this.debugLastGpioPin = '';
        this.debugPcStallTicks = 0;
        this.debugLastPc = this.cpu.core.PC >>> 0;
        this.lowPcAliasCandidate = -1;
        this.lowPcAliasRepeatCount = 0;
        this.pinsChanged = true;
        this.hasFaulted = false;
        this.attachUART();
        this.attachUSBSerial();
        this.emitDebugSnapshot('reset', performance.now(), true);
    }

    stop() {
        this.running = false;
        clearInterval(this.statusInterval);
        this.gpioUnsubscribers.forEach((dispose) => {
            try {
                dispose();
            } catch {
                // no-op
            }
        });
        this.gpioUnsubscribers = [];
    }
}

// ─── RP2040 MicroPython JS-native Runner ────────────────────────────────────
//
// Instead of loading a UF2 and wrestling with USB-CDC REPL, this runner
// interprets the user's MicroPython script directly in JavaScript and drives
// GPIO through the same propagateBoardPin mechanism used by RP2040Runner.
// It is far simpler, boots instantly, and works for the machine.Pin / sleep_ms
// subset that covers >90% of beginner Pico projects.
//
export class RP2040MicroPythonRunner implements BoardRunner {
    readonly cpu: null = null;
    readonly boardId: string;
    readonly instances: Map<string, BaseComponent>;

    private pyRunner: MicroPythonRunner | null = null;
    private currentWires: any[];
    private statusInterval: any;
    private onStateUpdate: (state: any) => void;
    private readonly onByteTransmit?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    private gpioState: Map<number, boolean> = new Map();
    private pinStates: Record<string, boolean> = {};

    constructor(
        private script: string,
        componentsDef: any[],
        wiresDef: any[],
        onStateUpdate: (state: any) => void,
        options: AVRRunnerOptions = {}
    ) {
        this.boardId = options.boardId || '';
        this.onStateUpdate = onStateUpdate;
        this.onByteTransmit = options.onByteTransmit;
        this.currentWires = Array.isArray(wiresDef) ? wiresDef : [];

        // Build component instances
        this.instances = new Map<string, BaseComponent>();
        (componentsDef || []).forEach((cDef) => {
            const LogicClass = LOGIC_REGISTRY[cDef.type];
            if (!LogicClass) return;
            const pinList = COMPONENT_PINS[cDef.type] || [];
            const inst = new LogicClass(cDef.id, { ...cDef, pins: pinList });
            this.instances.set(cDef.id, inst);
        });

        // Seed all GND/K pins to 0V and VCC pins to 3.3V at init
        this.seedFixedRails();

        // Start the interpreter
        this.startInterpreter();

        // Publish state periodically
        this.statusInterval = setInterval(() => this.publishState(), 50);
    }

    private seedFixedRails() {
        this.instances.forEach((inst) => {
            Object.keys(inst.pins).forEach((pinKey) => {
                const upper = pinKey.toUpperCase();
                if (upper === 'GND' || upper === 'VSS' || upper.startsWith('GND_') || upper === 'K') {
                    inst.setPinVoltage(pinKey, 0.0);
                }
                if (upper === '3V3' || upper === 'VCC') {
                    inst.setPinVoltage(pinKey, 3.3);
                }
            });
        });
    }

    private propagateGPIO(gpioNum: number, isHigh: boolean) {
        const voltage = isHigh ? 3.3 : 0.0;
        const gpPin = `GP${gpioNum}`;
        const visitedEdges = new Set<string>();

        const visitNode = (node: string) => {
            const [compId, compPin] = node.split(':');
            const inst = this.instances.get(compId);
            if (!inst) return;
            if (!inst.pins[compPin]) inst.pins[compPin] = { voltage: 0, mode: 'INPUT' };
            inst.setPinVoltage(compPin, voltage);

            // Traverse passive components (resistors etc.)
            for (const wire of this.currentWires) {
                const edgeKey = `${wire.from}|${wire.to}`;
                if (visitedEdges.has(edgeKey)) continue;
                const matchFrom = wire.from === node;
                const matchTo = wire.to === node;
                if (!matchFrom && !matchTo) continue;
                visitedEdges.add(edgeKey);
                const other = matchFrom ? wire.to : wire.from;
                const [oid, opin] = other.split(':');
                const oinst = this.instances.get(oid);
                if (oinst) visitNode(other);
            }
        };

        // Find wires connected to this GPIO pin of the board
        for (const wire of this.currentWires) {
            const edgeKey = `${wire.from}|${wire.to}`;
            const fromIsGP = wire.from.startsWith(`${this.boardId}:${gpPin}`) ||
                             wire.from === `${this.boardId}:GP${gpioNum}`;
            const toIsGP   = wire.to.startsWith(`${this.boardId}:${gpPin}`) ||
                             wire.to === `${this.boardId}:GP${gpioNum}`;
            if (!fromIsGP && !toIsGP) continue;
            visitedEdges.add(edgeKey);
            visitNode(fromIsGP ? wire.to : wire.from);
        }

        // Re-seed fixed rails (GND/VCC never change)
        this.seedFixedRails();

        // Tick component logic
        const instArray = Array.from(this.instances.values());
        instArray.forEach((inst) => inst.update(0, this.currentWires, instArray));
    }

    private publishState() {
        const components: { id: string; state: any }[] = [];
        this.instances.forEach((inst, id) => {
            if (inst.stateChanged) {
                components.push({ id, state: inst.getSyncState() });
                inst.stateChanged = false;
            }
        });
        if (components.length > 0) {
            this.onStateUpdate({ type: 'state', boardId: this.boardId, components, pins: this.pinStates });
        }
    }

    private startInterpreter() {
        this.pyRunner = new MicroPythonRunner(this.script, {
            onGpioChange: (gpioNum, isHigh) => {
                this.pinStates[`GP${gpioNum}`] = isHigh;
                this.propagateGPIO(gpioNum, isHigh);
                this.publishState();
            },
            onSerial: (text) => {
                for (const ch of text) {
                    const value = ch.charCodeAt(0);
                    if (this.onByteTransmit) {
                        this.onByteTransmit({ boardId: this.boardId, value, char: ch, source: 'micropython-js' });
                    } else {
                        this.onStateUpdate({ type: 'serial', data: ch, value, boardId: this.boardId, source: 'micropython-js' });
                    }
                }
            },
            onError: (msg) => {
                // Emit as serial output so user sees it
                const errText = `\r\n[MicroPython] ${msg}\r\n`;
                for (const ch of errText) {
                    const value = ch.charCodeAt(0);
                    if (this.onByteTransmit) {
                        this.onByteTransmit({ boardId: this.boardId, value, char: ch, source: 'micropython-js' });
                    } else {
                        this.onStateUpdate({ type: 'serial', data: ch, value, boardId: this.boardId, source: 'micropython-js' });
                    }
                }
            },
        });
        this.pyRunner.run().catch(() => {});
    }

    stop() {
        if (this.pyRunner) { this.pyRunner.stop(); this.pyRunner = null; }
        clearInterval(this.statusInterval);
    }

    reset() {
        this.stop();
        this.seedFixedRails();
        this.startInterpreter();
        this.statusInterval = setInterval(() => this.publishState(), 50);
    }

    serialRx(_data: string) { /* MicroPython JS runner doesn't use UART input */ }
    serialRxByte(_value: number) { /* no-op */ }
    setSerialBaudRate(_baud: number) { /* no-op */ }
    getSerialBaudRate() { return 115200; }
}

export function createRunnerForBoard(
    boardType: string,
    hexData: string,
    componentsDef: any[],
    wiresDef: any[],
    onStateUpdate: (state: any) => void,
    options: AVRRunnerOptions & { pyScript?: string; forceMicroPythonJsRunner?: boolean } = {}
): BoardRunner {
    if (/pico|rp2040/i.test(String(boardType || ''))) {
        if (options.forceMicroPythonJsRunner && typeof options.pyScript === 'string' && options.pyScript.trim()) {
            return new RP2040MicroPythonRunner(options.pyScript, componentsDef, wiresDef, onStateUpdate, options);
        }
        // Default RP2040 path: emulate firmware in rp2040js and inject over UART0.
        return new RP2040Runner(hexData, componentsDef, wiresDef, onStateUpdate, options);
    }
    return new AVRRunner(hexData, componentsDef, wiresDef, onStateUpdate, options);
}
