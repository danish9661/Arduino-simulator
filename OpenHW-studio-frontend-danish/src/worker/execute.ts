import { CPU, timer0Config, timer1Config, timer2Config, AVRTimer, avrInstruction, AVRADC, adcConfig, AVRUSART, usart0Config, AVRTWI, twiConfig, AVRSPI, spiConfig, AVRIOPort, portBConfig, portCConfig, portDConfig, PinState } from 'avr8js';
import { RP2040, GPIOPinState, ConsoleLogger, LogLevel, USBCDC, GDBServer, GDBConnection } from 'rp2040js';
import { bootromB1 } from './rp2040-bootrom.ts';

import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';
import { LEDLogic } from '@openhw/emulator/src/components/wokwi-led/logic.ts';
import { UnoLogic } from '@openhw/emulator/src/components/wokwi-arduino-uno/logic.ts';
import { PicoLogic } from './pico-logic.ts';
import { MicroPythonRunner } from './micropython-runtime.ts';
import { ResistorLogic } from '@openhw/emulator/src/components/wokwi-resistor/logic.ts';
import { PushbuttonLogic } from '@openhw/emulator/src/components/wokwi-pushbutton/logic.ts';
import { PowerSupplyLogic } from '@openhw/emulator/src/components/wokwi-power-supply/logic.ts';
import { NeopixelLogic } from './neopixel-logic.ts';
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

class GenericI2CDeviceLogic extends BaseComponent {
    private readonly address: number;
    private readonly readQueue: number[] = [];

    constructor(id: string, manifest: any) {
        super(id, manifest);

        const type = String(manifest?.type || '').toLowerCase();
        const defaultAddress = type === 'wokwi-lcd2004-i2c'
            ? 0x27
            : type === 'max30102'
                ? 0x57
                : 0x3c;
        const rawAddress = Number(
            manifest?.attrs?.address
            ?? manifest?.attrs?.i2cAddress
            ?? manifest?.attrs?.addr
            ?? defaultAddress
        );
        this.address = Number.isFinite(rawAddress) ? (rawAddress & 0x7f) : defaultAddress;

        this.state = {
            ...this.state,
            i2cAddress: this.address,
            i2cRxBytes: 0,
            i2cTxBytes: 0,
            lastWrite: 0,
            lastRead: 0xff,
        };
    }

    onI2CStart(address: number, read: boolean): boolean {
        const ack = (address & 0x7f) === this.address;
        this.state.lastReadMode = !!read;
        this.stateChanged = true;
        return ack;
    }

    onI2CByte(_address: number, data: number): boolean {
        const byte = data & 0xff;
        this.state.lastWrite = byte;
        this.state.i2cRxBytes = Number(this.state.i2cRxBytes || 0) + 1;
        this.stateChanged = true;

        if (this.readQueue.length < 32) {
            this.readQueue.push(byte);
        }
        return true;
    }

    onI2CReadByte(): number {
        const byte = this.readQueue.length > 0
            ? this.readQueue.shift()!
            : Number(this.state.defaultReadByte ?? 0xff) & 0xff;
        this.state.lastRead = byte;
        this.state.i2cTxBytes = Number(this.state.i2cTxBytes || 0) + 1;
        this.stateChanged = true;
        return byte;
    }
}

class GenericSPIDeviceLogic extends BaseComponent {
    onSPIByte(data: number): number {
        const byte = data & 0xff;
        this.state.lastWrite = byte;
        this.state.spiRxBytes = Number(this.state.spiRxBytes || 0) + 1;
        this.stateChanged = true;

        const response = Number(this.state.defaultReadByte ?? this.state.spiResponse ?? 0xff);
        return Number.isFinite(response) ? (response & 0xff) : 0xff;
    }
}

class SSD1306FallbackLogic extends BaseComponent {
    private vram: number[];
    private i2cAddress = 0x3c;
    private isAddressed = false;

    private awaitingControlByte = true;
    private isDataMode = false;
    private burstMode = false;

    private addressingMode = 2;
    private pageStart = 0;
    private pageEnd = 7;
    private colStart = 0;
    private colEnd = 127;
    private page = 0;
    private column = 0;

    private displayOn = true;
    private invert = false;
    private allOn = false;
    private contrast = 0x7f;
    private displayStartLine = 0;
    private segmentRemap = false;
    private multiplexRatio = 63;
    private comScanDir = false;
    private displayOffset = 0;
    private comConfig = 0x12;

    private pendingCommand = 0;
    private pendingArgs = 0;
    private args: number[] = [];

    private vramDirty = false;
    private cycleCount = 0;

    constructor(id: string, manifest: any) {
        super(id, manifest);
        this.vram = new Array(1024).fill(0);

        const rawAddress = Number(
            manifest?.attrs?.i2cAddress
            ?? manifest?.attrs?.address
            ?? 0x3c
        );
        if (Number.isFinite(rawAddress)) {
            this.i2cAddress = rawAddress & 0x7f;
        }

        this.state = {
            vram: [...this.vram],
            invert: false,
            allOn: false,
            displayOn: true,
            displayStartLine: 0,
            segmentRemap: false,
            comScanDir: false,
            displayOffset: 0,
        };
    }

    update(cpuCycles: number) {
        this.cycleCount += cpuCycles;
        if (this.cycleCount >= 266666) {
            this.cycleCount = 0;
            if (this.vramDirty) {
                this.vramDirty = false;
                this.setState({
                    vram: [...this.vram],
                    invert: this.invert,
                    allOn: this.allOn,
                    displayOn: this.displayOn,
                    displayStartLine: this.displayStartLine,
                    segmentRemap: this.segmentRemap,
                    comScanDir: this.comScanDir,
                    displayOffset: this.displayOffset,
                });
            }
        }
    }

    onI2CStart(addr: number, read: boolean): boolean {
        if ((addr & 0x7f) === this.i2cAddress) {
            if (read) return false;
            this.isAddressed = true;
            this.awaitingControlByte = true;
            return true;
        }
        this.isAddressed = false;
        return false;
    }

    onI2CByte(_addr: number, data: number): boolean {
        if (!this.isAddressed) return false;

        if (this.awaitingControlByte) {
            this.isDataMode = (data & 0x40) !== 0;
            this.burstMode = (data & 0x80) === 0;
            this.awaitingControlByte = false;
            return true;
        }

        if (this.isDataMode) {
            this.writeVram(data & 0xff);
        } else {
            this.processCommand(data & 0xff);
        }

        if (!this.burstMode) {
            this.awaitingControlByte = true;
        }
        return true;
    }

    onI2CStop() {
        this.isAddressed = false;
    }

    private writeVram(data: number) {
        const index = (this.page * 128) + this.column;
        if (index >= 0 && index < 1024) {
            this.vram[index] = data;
            this.vramDirty = true;
        }

        if (this.addressingMode === 0) {
            this.column += 1;
            if (this.column > this.colEnd) {
                this.column = this.colStart;
                this.page += 1;
                if (this.page > this.pageEnd) this.page = this.pageStart;
            }
        } else if (this.addressingMode === 1) {
            this.page += 1;
            if (this.page > this.pageEnd) {
                this.page = this.pageStart;
                this.column += 1;
                if (this.column > this.colEnd) this.column = this.colStart;
            }
        } else {
            this.column += 1;
            if (this.column > 127) this.column = 0;
        }
    }

    private getExpectedArgs(cmd: number): number {
        if (this.pendingArgs > 0) return this.pendingArgs;

        switch (cmd) {
            case 0x81: return 1;
            case 0x20: return 1;
            case 0x21: return 2;
            case 0x22: return 2;
            case 0xa8: return 1;
            case 0xd3: return 1;
            case 0xd5: return 1;
            case 0xd9: return 1;
            case 0xda: return 1;
            case 0xdb: return 1;
            case 0x8d: return 1;
            default: return 0;
        }
    }

    private processCommand(cmd: number) {
        if (this.pendingArgs > 0) {
            this.args.push(cmd);
            this.pendingArgs -= 1;
            if (this.pendingArgs === 0) this.executeCommand();
            return;
        }

        const expected = this.getExpectedArgs(cmd);
        if (expected > 0) {
            this.pendingCommand = cmd;
            this.pendingArgs = expected;
            this.args = [];
            return;
        }

        if (cmd >= 0xb0 && cmd <= 0xb7) {
            this.page = cmd & 0x07;
            return;
        }
        if ((cmd & 0xf0) === 0x00) {
            this.column = (this.column & 0xf0) | (cmd & 0x0f);
            return;
        }
        if ((cmd & 0xf0) === 0x10) {
            this.column = (this.column & 0x0f) | ((cmd & 0x0f) << 4);
            return;
        }
        if (cmd >= 0x40 && cmd <= 0x7f) {
            this.displayStartLine = cmd & 0x3f;
            this.vramDirty = true;
            return;
        }

        switch (cmd) {
            case 0xa0:
            case 0xa1:
                this.segmentRemap = (cmd === 0xa1);
                this.vramDirty = true;
                break;
            case 0xc0:
            case 0xc8:
                this.comScanDir = (cmd === 0xc8);
                this.vramDirty = true;
                break;
            case 0xa4:
                this.allOn = false;
                this.vramDirty = true;
                break;
            case 0xa5:
                this.allOn = true;
                this.vramDirty = true;
                break;
            case 0xa6:
                this.invert = false;
                this.vramDirty = true;
                break;
            case 0xa7:
                this.invert = true;
                this.vramDirty = true;
                break;
            case 0xae:
                this.displayOn = false;
                this.vramDirty = true;
                break;
            case 0xaf:
                this.displayOn = true;
                this.vramDirty = true;
                break;
            default:
                break;
        }
    }

    private executeCommand() {
        switch (this.pendingCommand) {
            case 0x20:
                this.addressingMode = this.args[0] & 0x03;
                break;
            case 0x21:
                this.colStart = this.args[0] & 0x7f;
                this.colEnd = this.args[1] & 0x7f;
                this.column = this.colStart;
                break;
            case 0x22:
                this.pageStart = this.args[0] & 0x07;
                this.pageEnd = this.args[1] & 0x07;
                this.page = this.pageStart;
                break;
            case 0x81:
                this.contrast = this.args[0] & 0xff;
                break;
            case 0xa8:
                this.multiplexRatio = this.args[0] & 0x3f;
                break;
            case 0xd3:
                this.displayOffset = this.args[0] & 0x3f;
                this.vramDirty = true;
                break;
            case 0xda:
                this.comConfig = this.args[0] & 0xff;
                this.vramDirty = true;
                break;
            default:
                break;
        }
        this.pendingCommand = 0;
    }

    getSyncState() {
        return { ...this.state };
    }
}

class Lcd2004I2CFallbackLogic extends BaseComponent {
    private readonly i2cAddress: number;
    private backlight = true;
    private mode4bit = false;
    private cursorX = 0;
    private cursorY = 0;
    private linesData: string[] = [
        '                    ',
        '                    ',
        '                    ',
        '                    ',
    ];
    private halfByte = 0;
    private isNibble = false;
    private lastByte = 0;

    constructor(id: string, manifest: any) {
        super(id, manifest);
        const rawAddress = Number(
            manifest?.attrs?.i2cAddress
            ?? manifest?.attrs?.address
            ?? 0x27
        );
        this.i2cAddress = Number.isFinite(rawAddress) ? (rawAddress & 0x7f) : 0x27;
        this.state = { lines: [...this.linesData], illuminated: this.backlight };
    }

    onI2CStart(addr: number, isRead: boolean): boolean {
        return !isRead && ((addr & 0x7f) === this.i2cAddress);
    }

    onI2CByte(_addr: number, value: number): boolean {
        const rs = (value & 0x01) !== 0;
        const rw = (value & 0x02) !== 0;
        const en = (value & 0x04) !== 0;
        const bl = (value & 0x08) !== 0;
        const lastEn = (this.lastByte & 0x04) !== 0;

        if (lastEn && !en && !rw) {
            const dataNibble = value & 0xf0;
            if (!this.mode4bit) {
                this.processLCDCommand(rs, dataNibble);
            } else if (!this.isNibble) {
                this.halfByte = dataNibble;
                this.isNibble = true;
            } else {
                const fullByte = this.halfByte | (dataNibble >> 4);
                this.isNibble = false;
                this.processLCDCommand(rs, fullByte);
            }
        }

        if (this.backlight !== bl) {
            this.backlight = bl;
            this.stateChanged = true;
        }

        this.lastByte = value;
        this.updateState();
        return true;
    }

    private processLCDCommand(rs: boolean, data: number) {
        if (!rs) {
            if (data === 0x01) {
                this.linesData = ['                    ', '                    ', '                    ', '                    '];
                this.cursorX = 0;
                this.cursorY = 0;
            } else if (data === 0x02 || data === 0x03) {
                this.cursorX = 0;
                this.cursorY = 0;
            } else if ((data & 0xf0) === 0x20) {
                this.mode4bit = true;
            } else if ((data & 0xf0) === 0x30) {
                this.mode4bit = false;
                this.isNibble = false;
            } else if ((data & 0x80) === 0x80) {
                const addr = data & 0x7f;
                if (addr >= 0x00 && addr < 0x14) {
                    this.cursorY = 0;
                    this.cursorX = addr;
                } else if (addr >= 0x40 && addr < 0x54) {
                    this.cursorY = 1;
                    this.cursorX = addr - 0x40;
                } else if (addr >= 0x14 && addr < 0x28) {
                    this.cursorY = 2;
                    this.cursorX = addr - 0x14;
                } else if (addr >= 0x54 && addr < 0x68) {
                    this.cursorY = 3;
                    this.cursorX = addr - 0x54;
                }
            }
        } else if (this.cursorY < 4 && this.cursorX < 20) {
            const lineArray = this.linesData[this.cursorY].split('');
            lineArray[this.cursorX] = String.fromCharCode(data & 0xff);
            this.linesData[this.cursorY] = lineArray.join('');
            this.cursorX += 1;
        }

        this.stateChanged = true;
    }

    private updateState() {
        this.state.lines = [...this.linesData];
        this.state.illuminated = this.backlight;
    }

    getSyncState() {
        return { ...this.state };
    }
}

class ILI9341FallbackLogic extends BaseComponent {
    private dcHigh = false;
    private csHigh = true;
    private currentCommand = 0;

    private colStart = 0;
    private colEnd = 239;
    private rowStart = 0;
    private rowEnd = 319;
    private currentX = 0;
    private currentY = 0;

    private params: number[] = [];
    private secondByte = false;
    private firstByteValue = 0;

    private vram = new Uint8Array(240 * 320 * 3);
    private vramDirty = false;
    private lastSync = 0;
    private powerOn = true;
    private spiRxBytes = 0;
    private spiCmdBytes = 0;
    private spiDataBytes = 0;
    private ramwrPixels = 0;

    constructor(id: string, manifest: any) {
        super(id, manifest);
        this.state = {
            buffer: this.vram,
            powerOn: true,
            t: Date.now(),
            spiRxBytes: 0,
            spiCmdBytes: 0,
            spiDataBytes: 0,
            ramwrPixels: 0,
            lastCommand: 0,
            csHigh: true,
            dcHigh: false,
        };
    }

    update() {
        const now = Date.now();
        const newPower = this.getPinVoltage('VCC') > 2.0;

        if (newPower !== this.powerOn) {
            this.powerOn = newPower;
            this.stateChanged = true;
            if (!this.powerOn) {
                this.vram.fill(0);
                this.vramDirty = true;
            }
        }

        const minFlushIntervalMs = this.powerOn ? 40 : 0;
        if (this.vramDirty && (now - this.lastSync) >= minFlushIntervalMs) {
            this.lastSync = now;
            this.vramDirty = false;
            this.stateChanged = true;
        }
    }

    onPinStateChange(pinId: string, isHigh: boolean) {
        const pin = String(pinId || '').toUpperCase();
        if (pin === 'DC') {
            this.dcHigh = isHigh;
        } else if (pin === 'CS') {
            this.csHigh = isHigh;
            if (isHigh) {
                this.params = [];
                this.secondByte = false;
            }
        } else if (pin === 'RESET' && !isHigh) {
            this.vram.fill(0);
            this.vramDirty = true;
        }
    }

    onSPIByte(data: number): number {
        this.spiRxBytes += 1;
        if (this.csHigh || !this.powerOn) return 0xff;

        if (!this.dcHigh) {
            this.currentCommand = data & 0xff;
            this.spiCmdBytes += 1;
            this.params = [];
            this.secondByte = false;
            if (this.currentCommand === 0x2c) {
                this.currentX = this.colStart;
                this.currentY = this.rowStart;
            }
        } else {
            this.spiDataBytes += 1;
            this.handleDataByte(data & 0xff);
        }
        return 0x00;
    }

    private handleDataByte(data: number) {
        switch (this.currentCommand) {
            case 0x2a:
                this.params.push(data);
                if (this.params.length === 4) {
                    this.colStart = (this.params[0] << 8) | this.params[1];
                    this.colEnd = (this.params[2] << 8) | this.params[3];
                    this.currentX = this.colStart;
                }
                break;
            case 0x2b:
                this.params.push(data);
                if (this.params.length === 4) {
                    this.rowStart = (this.params[0] << 8) | this.params[1];
                    this.rowEnd = (this.params[2] << 8) | this.params[3];
                    this.currentY = this.rowStart;
                }
                break;
            case 0x2c:
                if (!this.secondByte) {
                    this.firstByteValue = data;
                    this.secondByte = true;
                } else {
                    const full = (this.firstByteValue << 8) | data;
                    this.secondByte = false;

                    const r = ((full >> 11) & 0x1f) << 3;
                    const g = ((full >> 5) & 0x3f) << 2;
                    const b = (full & 0x1f) << 3;

                    if (this.currentX >= 0 && this.currentX < 240 && this.currentY >= 0 && this.currentY < 320) {
                        const idx = (this.currentY * 240 + this.currentX) * 3;
                        this.vram[idx] = r;
                        this.vram[idx + 1] = g;
                        this.vram[idx + 2] = b;
                        this.vramDirty = true;
                        this.ramwrPixels += 1;
                    }

                    this.currentX += 1;
                    if (this.currentX > this.colEnd) {
                        this.currentX = this.colStart;
                        this.currentY += 1;
                        if (this.currentY > this.rowEnd) {
                            this.currentY = this.rowStart;
                        }
                    }
                }
                break;
            default:
                break;
        }
    }

    getSyncState() {
        return {
            buffer: this.vram,
            powerOn: this.powerOn,
            spiRxBytes: this.spiRxBytes,
            spiCmdBytes: this.spiCmdBytes,
            spiDataBytes: this.spiDataBytes,
            ramwrPixels: this.ramwrPixels,
            lastCommand: this.currentCommand,
            csHigh: this.csHigh,
            dcHigh: this.dcHigh,
            t: Date.now(),
        };
    }
}

export const LOGIC_REGISTRY: Record<string, any> = {
    'wokwi-led': LEDLogic,
    'wokwi-arduino-uno': UnoLogic,
    'wokwi-raspberry-pi-pico': PicoLogic,
    'wokwi-raspberry-pi-pico-w': PicoLogic,
    'wokwi-resistor': ResistorLogic,
    'wokwi-pushbutton': PushbuttonLogic,
    'wokwi-power-supply': PowerSupplyLogic,
    'wokwi-neopixel-matrix': NeopixelLogic,
    'wokwi-ws2812b': NeopixelLogic,
    'wokwi-ws2821b': NeopixelLogic,
    'wokwi-buzzer': BuzzerLogic,
    'wokwi-motor': MotorLogic,
    'wokwi-servo': ServoLogic,
    'wokwi-motor-driver': MotorDriverLogic,
    'wokwi-slide-potentiometer': SlidePotLogic,
    'wokwi-potentiometer': PotentiometerLogic,
    'wokwi-lcd2004-i2c': Lcd2004I2CFallbackLogic,
    'wokwi-ssd1306-oled': SSD1306FallbackLogic,
    max30102: GenericI2CDeviceLogic,
    'wokwi-max7219': GenericSPIDeviceLogic,
    'wokwi-ldr-module': BaseComponent,
    'wokwi-7segment': BaseComponent,
    'wokwi-ili9341': ILI9341FallbackLogic,
    'wokwi-sd-card': SDCardLogic,
    'shift_register': ShiftRegisterLogic,
};

// Per-type pin lists so every component's pins are registered correctly
export const COMPONENT_PINS: Record<string, { id: string }[]> = {
    'wokwi-led': [{ id: 'A' }, { id: 'K' }],
    'wokwi-arduino-uno': UNO_BOARD_PINS.map((id: string) => ({ id })),
    'wokwi-raspberry-pi-pico': PICO_BOARD_PINS.map((id: string) => ({ id })),
    'wokwi-raspberry-pi-pico-w': PICO_BOARD_PINS.map((id: string) => ({ id })),
    'wokwi-resistor': [{ id: 'p1' }, { id: 'p2' }],
    'wokwi-pushbutton': [{ id: '1' }, { id: '2' }],
    'wokwi-buzzer': [{ id: '1' }, { id: '2' }],
    'wokwi-neopixel-matrix': [{ id: 'DIN' }, { id: 'VCC' }, { id: 'GND' }],
    'wokwi-ws2812b': [{ id: 'DIN' }, { id: 'VCC' }, { id: 'GND' }],
    'wokwi-ws2821b': [{ id: 'DIN' }, { id: 'VCC' }, { id: 'GND' }],
    'wokwi-servo': [{ id: 'GND' }, { id: 'V+' }, { id: 'PWM' }],
    'wokwi-motor': [{ id: '1' }, { id: '2' }],
    'wokwi-motor-driver': [{ id: 'ENA' }, { id: 'ENB' }, { id: 'IN1' }, { id: 'IN2' }, { id: 'IN3' }, { id: 'IN4' }, { id: 'OUT1' }, { id: 'OUT2' }, { id: 'OUT3' }, { id: 'OUT4' }, { id: '12V' }, { id: '5V' }, { id: 'GND' }],
    'wokwi-potentiometer': [{ id: '1' }, { id: '2' }, { id: 'SIG' }],
    'wokwi-slide-potentiometer': [{ id: 'GND' }, { id: 'SIG' }, { id: 'VCC' }],
    'wokwi-lcd2004-i2c': [{ id: 'GND' }, { id: 'VCC' }, { id: 'SDA' }, { id: 'SCL' }],
    'wokwi-ssd1306-oled': [{ id: 'GND' }, { id: 'VCC' }, { id: 'SCL' }, { id: 'SDA' }],
    max30102: [{ id: 'VIN' }, { id: 'SDA' }, { id: 'SCL' }, { id: 'GND' }, { id: 'INT' }, { id: 'IRD' }, { id: 'RD' }, { id: 'NC' }],
    'wokwi-max7219': [{ id: 'VCC' }, { id: 'GND' }, { id: 'DIN' }, { id: 'CS' }, { id: 'CLK' }, { id: 'VCC_OUT' }, { id: 'GND_OUT' }, { id: 'DOUT' }, { id: 'CS_OUT' }, { id: 'CLK_OUT' }],
    'wokwi-ldr-module': [{ id: 'VCC' }, { id: 'GND' }, { id: 'DO' }, { id: 'AO' }],
    'wokwi-7segment': [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'G' }, { id: 'DP' }, { id: 'DIG1' }, { id: 'DIG2' }, { id: 'DIG3' }, { id: 'DIG4' }, { id: 'COLON' }],
    'wokwi-ili9341': [{ id: 'VCC' }, { id: 'GND' }, { id: 'CS' }, { id: 'RESET' }, { id: 'DC' }, { id: 'MOSI' }, { id: 'SCK' }, { id: 'LED' }, { id: 'MISO' }],
    'wokwi-sd-card': [{ id: 'VCC' }, { id: 'GND' }, { id: 'CS' }, { id: 'SCK' }, { id: 'MOSI' }, { id: 'MISO' }],
    'wokwi-power-supply': [{ id: 'GND' }, { id: 'VCC' }],
    'shift_register': [{ id: 'vcc' }, { id: 'gnd' }, { id: 'ser' }, { id: 'srclk' }, { id: 'rclk' }, { id: 'oe' }, { id: 'srclr' }, { id: 'q0' }, { id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' }, { id: 'q5' }, { id: 'q6' }, { id: 'q7' }, { id: 'q7s' }],
};

type RP2040ExecutableRangeInput =
    | [number | string, number | string]
    | { start: number | string; end: number | string }
    | { start: number | string; size: number | string };

type RP2040ExecutableRange = {
    start: number;
    end: number;
    description?: string;
};

function parseAddressValue(raw: unknown): number | null {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return null;
        const clamped = Math.max(0, Math.min(0xffffffff, Math.floor(raw)));
        return clamped >>> 0;
    }

    if (typeof raw === 'string') {
        const value = raw.trim();
        if (!value) return null;
        const parsed = /^0x[0-9a-f]+$/i.test(value)
            ? parseInt(value, 16)
            : Number(value);
        if (!Number.isFinite(parsed)) return null;
        const clamped = Math.max(0, Math.min(0xffffffff, Math.floor(parsed)));
        return clamped >>> 0;
    }

    return null;
}

function normalizeRp2040ExecutableRanges(value: unknown): RP2040ExecutableRange[] {
    if (!Array.isArray(value)) return [];
    const ranges: RP2040ExecutableRange[] = [];

    for (const raw of value) {
        let start: number | null = null;
        let end: number | null = null;

        if (Array.isArray(raw) && raw.length >= 2) {
            start = parseAddressValue(raw[0]);
            end = parseAddressValue(raw[1]);
        } else if (raw && typeof raw === 'object') {
            const obj = raw as Record<string, unknown>;
            start = parseAddressValue(obj.start);

            if (Object.prototype.hasOwnProperty.call(obj, 'end')) {
                end = parseAddressValue(obj.end);
            } else if (Object.prototype.hasOwnProperty.call(obj, 'size')) {
                const size = parseAddressValue(obj.size);
                if (start !== null && size !== null && size > 0) {
                    const rawEnd = Number(start) + Number(size) - 1;
                    end = Math.max(0, Math.min(0xffffffff, Math.floor(rawEnd))) >>> 0;
                }
            }
        }

        if (start === null || end === null || end < start) {
            continue;
        }

        ranges.push({ start: start >>> 0, end: end >>> 0 });
    }

    return ranges;
}

export type AVRRunnerOptions = {
    boardId?: string;
    onByteTransmit?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    serialBaudRate?: number;
    debugEnabled?: boolean;
    debugIntervalMs?: number;
    forceMicroPythonJsRunner?: boolean;
    rp2040ExecutableRanges?: RP2040ExecutableRangeInput[];
};

export type BoardRunner = {
    cpu: any;
    boardId: string;
    instances: Map<string, BaseComponent>;
    stop: () => void;
    reset?: () => void;
    serialRx: (data: string) => void;
    serialRxByte: (value: number) => void;
    serialRxByteFromSource?: (value: number, source?: string) => void;
    softSerialRxByte?: (value: number) => void;
    setSerialBaudRate: (baud: number) => void;
    getSerialBaudRate: () => number;
};

const RP2040_FLASH_BASE = 0x10000000;
const RP2040_XIP_NOCACHE_BASE = 0x11000000;
const RP2040_BOOTROM_BASE = 0x00000000;
const RP2040_BOOTROM_SIZE = 0x4000;
const RP2040_SRAM_BASE = 0x20000000;
const RP2040_USB_RAM_BASE = 0x50100000;
const RP2040_USB_RAM_SIZE = 0x1000;
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
const SOFT_SERIAL_SOURCE_LABELS = new Set(['softserial', 'soft-serial', 'soft_uart', 'soft-uart', 'softuart']);

function isSoftSerialSourceLabel(source: string): boolean {
    const key = String(source || '').trim().toLowerCase();
    return SOFT_SERIAL_SOURCE_LABELS.has(key);
}

const RP2040_I2C_SOURCE_PINS = {
    i2c0: {
        sda: ['SDA', 'GP0', 'GPIO0', 'D0', '0', 'GP4', 'GPIO4', 'D4', '4', 'GP8', 'GPIO8', 'D8', '8', 'GP12', 'GPIO12', 'D12', '12', 'GP16', 'GPIO16', 'D16', '16', 'GP20', 'GPIO20', 'D20', '20', 'GP24', 'GPIO24', 'D24', '24', 'GP28', 'GPIO28', 'D28', '28'],
        scl: ['SCL', 'GP1', 'GPIO1', 'D1', '1', 'GP5', 'GPIO5', 'D5', '5', 'GP9', 'GPIO9', 'D9', '9', 'GP13', 'GPIO13', 'D13', '13', 'GP17', 'GPIO17', 'D17', '17', 'GP21', 'GPIO21', 'D21', '21', 'GP25', 'GPIO25', 'D25', '25'],
    },
    i2c1: {
        sda: ['SDA1', 'GP2', 'GPIO2', 'D2', '2', 'GP6', 'GPIO6', 'D6', '6', 'GP10', 'GPIO10', 'D10', '10', 'GP14', 'GPIO14', 'D14', '14', 'GP18', 'GPIO18', 'D18', '18', 'GP22', 'GPIO22', 'D22', '22', 'GP26', 'GPIO26', 'D26', '26'],
        scl: ['SCL1', 'GP3', 'GPIO3', 'D3', '3', 'GP7', 'GPIO7', 'D7', '7', 'GP11', 'GPIO11', 'D11', '11', 'GP15', 'GPIO15', 'D15', '15', 'GP19', 'GPIO19', 'D19', '19', 'GP23', 'GPIO23', 'D23', '23', 'GP27', 'GPIO27', 'D27', '27'],
    },
};

const RP2040_SPI_SOURCE_PINS = {
    spi0: {
        mosi: ['MOSI', 'TX0', 'GP3', 'GPIO3', 'D3', '3', 'GP7', 'GPIO7', 'D7', '7', 'GP19', 'GPIO19', 'D19', '19', 'GP23', 'GPIO23', 'D23', '23'],
        miso: ['MISO', 'RX0', 'GP0', 'GPIO0', 'D0', '0', 'GP4', 'GPIO4', 'D4', '4', 'GP16', 'GPIO16', 'D16', '16', 'GP20', 'GPIO20', 'D20', '20'],
        sck: ['SCK', 'CLK', 'SCLK', 'GP2', 'GPIO2', 'D2', '2', 'GP6', 'GPIO6', 'D6', '6', 'GP18', 'GPIO18', 'D18', '18', 'GP22', 'GPIO22', 'D22', '22'],
        cs: ['CS', 'SS', 'CSN', 'NSS', 'GP1', 'GPIO1', 'D1', '1', 'GP5', 'GPIO5', 'D5', '5', 'GP17', 'GPIO17', 'D17', '17', 'GP21', 'GPIO21', 'D21', '21'],
    },
    spi1: {
        mosi: ['MOSI1', 'TX1', 'GP11', 'GPIO11', 'D11', '11', 'GP15', 'GPIO15', 'D15', '15', 'GP27', 'GPIO27', 'D27', '27'],
        miso: ['MISO1', 'RX1', 'GP8', 'GPIO8', 'D8', '8', 'GP12', 'GPIO12', 'D12', '12', 'GP24', 'GPIO24', 'D24', '24', 'GP28', 'GPIO28', 'D28', '28'],
        sck: ['SCK1', 'CLK1', 'SCLK1', 'GP10', 'GPIO10', 'D10', '10', 'GP14', 'GPIO14', 'D14', '14', 'GP26', 'GPIO26', 'D26', '26'],
        cs: ['CS1', 'SS1', 'CSN1', 'NSS1', 'GP9', 'GPIO9', 'D9', '9', 'GP13', 'GPIO13', 'D13', '13', 'GP25', 'GPIO25', 'D25', '25'],
    },
};

const RP2040_GPIO_FUNC_PWM = 4;
const RP2040_GPIO_FUNC_PIO0 = 6;
const RP2040_GPIO_FUNC_PIO1 = 7;

type ConnectedComponentPin = {
    inst: BaseComponent;
    pinId: string;
};

function collectConnectedComponentPins(
    boardId: string,
    boardPinAliases: string[],
    wires: any[],
    instances: Map<string, BaseComponent>
): ConnectedComponentPin[] {
    const aliasSet = new Set(boardPinAliases.map((v) => String(v || '').toUpperCase()));
    const adjacency = new Map<string, Set<string>>();

    const connect = (a: string, b: string) => {
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());
        adjacency.get(a)!.add(b);
        adjacency.get(b)!.add(a);
    };

    for (const wire of wires || []) {
        if (!wire?.from || !wire?.to) continue;
        connect(String(wire.from), String(wire.to));
    }

    for (const [id, inst] of instances.entries()) {
        if (inst.type === 'wokwi-resistor') {
            connect(`${id}:p1`, `${id}:p2`);
        }
    }

    const startNodes: string[] = [];
    for (const node of adjacency.keys()) {
        const [compId, pinId] = String(node).split(':');
        if (compId !== boardId) continue;
        if (aliasSet.has(String(pinId || '').toUpperCase())) {
            startNodes.push(node);
        }
    }

    if (!startNodes.length) return [];

    const visited = new Set<string>();
    const queue = [...startNodes];
    startNodes.forEach((n) => visited.add(n));

    while (queue.length > 0) {
        const node = queue.shift()!;
        for (const n of adjacency.get(node) || []) {
            if (visited.has(n)) continue;
            visited.add(n);
            queue.push(n);
        }
    }

    const out = new Map<string, ConnectedComponentPin>();
    for (const node of visited) {
        const [compId, pinId] = String(node).split(':');
        if (!compId || compId === boardId) continue;
        const inst = instances.get(compId);
        if (!inst) continue;
        if (inst.type === 'wokwi-resistor') continue;
        out.set(`${compId}:${pinId}`, { inst, pinId });
    }

    return Array.from(out.values());
}

function invokeOptional(inst: any, names: string[], args: any[]): any {
    for (const name of names) {
        const fn = inst?.[name];
        if (typeof fn === 'function') {
            return fn.apply(inst, args);
        }
    }
    return undefined;
}

const MEDIUM_COMPONENT_STATE_WEIGHT = 2_048;
const HEAVY_COMPONENT_STATE_WEIGHT = 8_192;
const MEDIUM_COMPONENT_MIN_SYNC_MS = 55;
const HEAVY_COMPONENT_MIN_SYNC_MS = 95;

function estimateStatePayloadWeight(value: any, depth = 0): number {
    if (value == null) return 0;

    if (typeof value === 'string') return value.length;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;

    if (ArrayBuffer.isView(value)) {
        return Number((value as any)?.byteLength || (value as any)?.length || 0);
    }

    if (value instanceof ArrayBuffer) {
        return Number(value.byteLength || 0);
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return 0;
        if (depth >= 2) return value.length;

        const sampleCount = Math.min(value.length, 16);
        let sampleWeight = 0;
        for (let i = 0; i < sampleCount; i++) {
            sampleWeight += estimateStatePayloadWeight(value[i], depth + 1);
        }
        const avg = sampleCount > 0 ? (sampleWeight / sampleCount) : 0;
        return Math.round(avg * value.length);
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return 0;
        if (depth >= 2) return entries.length * 12;

        let weight = 0;
        for (const [k, v] of entries) {
            weight += String(k || '').length;
            weight += estimateStatePayloadWeight(v, depth + 1);
        }
        return weight;
    }

    return 0;
}

function getComponentStateSyncPolicy(state: any): { weight: number; minIntervalMs: number } {
    const weight = estimateStatePayloadWeight(state);
    if (weight >= HEAVY_COMPONENT_STATE_WEIGHT) {
        return { weight, minIntervalMs: HEAVY_COMPONENT_MIN_SYNC_MS };
    }
    if (weight >= MEDIUM_COMPONENT_STATE_WEIGHT) {
        return { weight, minIntervalMs: MEDIUM_COMPONENT_MIN_SYNC_MS };
    }
    return { weight, minIntervalMs: 0 };
}

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
            || (a >= RP2040_BOOTROM_BASE && a < (RP2040_BOOTROM_BASE + RP2040_BOOTROM_SIZE))
            || (a >= RP2040_USB_RAM_BASE && a < (RP2040_USB_RAM_BASE + RP2040_USB_RAM_SIZE));
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

    type RP2040VectorCandidate = {
        base: number;
        initialSP: number;
        initialPC: number;
        resolvedPC: number;
        strategy: string;
        score: number;
    };

    const evaluateVectorBase = (base: number, strategy: string): RP2040VectorCandidate | null => {
        const initialSP = readWord(base) >>> 0;
        const initialPC = readWord((base + 4) >>> 0) >>> 0;

        if (initialSP === 0 || initialPC === 0 || initialSP === 0xffffffff || initialPC === 0xffffffff) {
            return null;
        }

        const resolvedPC = resolvePcAddress((initialPC & ~1) >>> 0);
        const validSP = initialSP >= sramStart
            && initialSP <= sramEnd
            && (initialSP & 0x3) === 0;
        const validPC = isExecutableAddress(resolvedPC) && hasInstructionWord(resolvedPC);
        if (!validSP || !validPC) {
            return null;
        }

        let score = 100;

        // Penalize vectors that resolve inside early boot2 area; these are often false positives.
        if (resolvedPC >= RP2040_FLASH_BASE && resolvedPC < (RP2040_FLASH_BASE + 0x800)) {
            score -= 35;
        }

        // Reward vectors that point into application flash region.
        if (resolvedPC >= (RP2040_FLASH_BASE + 0x800) && resolvedPC < flashEnd) {
            score += 15;
        }

        let populatedVectors = 0;
        let validVectorHandlers = 0;
        for (let i = 2; i < 16; i++) {
            const rawHandler = readWord((base + (i * 4)) >>> 0) >>> 0;
            if (rawHandler === 0 || rawHandler === 0xffffffff) {
                continue;
            }

            populatedVectors += 1;
            const handlerAddr = resolvePcAddress((rawHandler & ~1) >>> 0);
            const looksThumb = (rawHandler & 0x1) === 0x1;
            if (looksThumb && isExecutableAddress(handlerAddr)) {
                validVectorHandlers += 1;
                score += 3;
            } else {
                score -= 5;
            }
        }

        if (populatedVectors === 0) {
            score -= 10;
        }
        if (validVectorHandlers >= 6) {
            score += 12;
        }

        return {
            base: base >>> 0,
            initialSP,
            initialPC,
            resolvedPC: resolvedPC >>> 0,
            strategy,
            score,
        };
    };

    const candidates: RP2040VectorCandidate[] = [];
    const preferredBases = [
        { offset: 0x100, strategy: 'vector+0x100' },
        { offset: 0x000, strategy: 'vector+0x000' },
    ];
    for (const preferred of preferredBases) {
        const candidate = evaluateVectorBase((RP2040_FLASH_BASE + preferred.offset) >>> 0, preferred.strategy);
        if (candidate) candidates.push(candidate);
    }

    // Arduino-Pico and other RP2040 toolchains may place the vector table beyond +0x100.
    // Scan a reasonable early-flash window in 0x100-byte aligned steps.
    const scanLimit = Math.min(rp2040.flash.length, 0x80000);
    for (let offset = 0x200; offset < scanLimit; offset += 0x100) {
        const candidate = evaluateVectorBase(
            (RP2040_FLASH_BASE + offset) >>> 0,
            `vector+0x${offset.toString(16)}`
        );
        if (candidate) {
            candidates.push(candidate);
        }
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.base - b.base;
        });

        const best = candidates[0];
        rp2040.core.SP = best.initialSP;
        rp2040.core.VTOR = best.base >>> 0;
        rp2040.core.BXWritePC(((best.resolvedPC | 1) >>> 0));
        rp2040.core.xPSR = 0x01000000;

        return {
            vectorBase: best.base >>> 0,
            initialSP: best.initialSP,
            initialPC: best.initialPC,
            resolvedPC: best.resolvedPC >>> 0,
            usedFallback: false,
            strategy: `${best.strategy} score=${best.score}`,
            probe0100SP,
            probe0100PC,
            probe0000SP,
            probe0000PC,
        };
    }

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
    private softSerialBaudRate: number = 9600;
    private serialByteBudget: number = 0;
    private readonly onStateUpdate: (state: any) => void;
    private readonly onByteTransmitCb?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    private readonly softSerialRxPin = '11';
    private readonly softSerialTxPin = '10';
    private softSerialRxLineLow = false;
    private softSerialNextInjectCycle = 0;
    private softSerialDecodeState = {
        receiving: false,
        sampleCycle: 0,
        sampleIndex: 0,
        currentByte: 0,
        lastLevel: true,
    };
    private i2sState = new Map<string, { bclkLast: boolean; wsLast: boolean; shiftBuf: number; bitCount: number }>();
    private pwmState = new Map<string, { lastRiseCycle: number; lastFallCycle: number; lastPeriodCycles: number }>();
    private oneWireState = new Map<string, { lowStartCycle: number | null; highStartCycle: number | null }>();
    private protocolEndpointsCache = new Map<string, ConnectedComponentPin[]>();
    private componentSyncMeta = new Map<string, { lastSentAt: number; lastWeight: number }>();

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
        this.setSoftSerialRxLevel(true);

        this.running = true;
        this.lastTime = performance.now();
        this.runLoop();

        // Send compact board state frequently, but coalesce large component payloads.
        this.statusInterval = setInterval(() => {
            if (this.running && this.cpu) {
                const msg: any = { type: 'state' };
                const now = performance.now();

                if (this.pinsChanged) {
                    msg.pins = this.pinStates;
                    this.pinsChanged = false;
                }

                if (this.adc) {
                    msg.analog = Array.from(this.adc.channelValues);
                }

                const compStates: Array<{ id: string; state: any }> = [];
                for (const inst of this.instances.values()) {
                    if (!inst.stateChanged) continue;
                    const syncState = inst.getSyncState();
                    if (!this.shouldEmitComponentState(inst.id, syncState, now)) continue;
                    inst.stateChanged = false;
                    compStates.push({ id: inst.id, state: syncState });
                }

                if (compStates.length > 0) {
                    msg.components = compStates;
                }

                // Always send state to ensure continuous plotter timing and analog tracking
                if (!msg.pins) msg.pins = this.pinStates; // Ensure plotData has pins object
                msg.boardId = this.boardId;
                this.onStateUpdate(msg);
            }
        }, 1000 / 30);
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

    private getSoftSerialBitCycles(): number {
        const baud = Math.max(300, this.softSerialBaudRate | 0);
        return Math.max(1, Math.floor(16_000_000 / baud));
    }

    private setSoftSerialRxLevel(isHigh: boolean) {
        this.softSerialRxLineLow = !isHigh;
        // UNO pin 11 is PB3 (index 3 in PORTB mapping [8..13]).
        this.portB?.setPin(3, isHigh);
    }

    private emitSoftSerialByte(value: number) {
        const byte = value & 0xff;
        const char = String.fromCharCode(byte);
        this.pulseBoardLed('1');
        if (this.onByteTransmitCb) {
            this.onByteTransmitCb({ boardId: this.boardId, value: byte, char, source: 'softserial' });
        } else {
            this.onStateUpdate({ type: 'serial', data: char, value: byte, boardId: this.boardId, source: 'softserial' });
        }
    }

    private processSoftSerialDecode(cycles: number) {
        const state = this.softSerialDecodeState;
        if (!state.receiving) return;
        const bitCycles = this.getSoftSerialBitCycles();

        while (state.receiving && state.sampleCycle <= cycles) {
            if (state.sampleIndex < 8) {
                if (state.lastLevel) {
                    state.currentByte |= (1 << state.sampleIndex);
                }
                state.sampleIndex += 1;
                state.sampleCycle += bitCycles;
                continue;
            }

            // Stop bit: valid frame when line is HIGH.
            if (state.lastLevel) {
                this.emitSoftSerialByte(state.currentByte);
            }
            state.receiving = false;
            state.sampleIndex = 0;
            state.currentByte = 0;
        }
    }

    private observeSoftSerialTx(pinId: string, isHigh: boolean, cycles: number) {
        if (pinId !== this.softSerialTxPin) return;
        const state = this.softSerialDecodeState;

        this.processSoftSerialDecode(cycles);

        const prev = state.lastLevel;
        state.lastLevel = isHigh;

        // Falling edge while idle => start bit.
        if (!state.receiving && prev && !isHigh) {
            const bitCycles = this.getSoftSerialBitCycles();
            state.receiving = true;
            state.currentByte = 0;
            state.sampleIndex = 0;
            state.sampleCycle = cycles + (bitCycles * 1.5);
        }
    }

    private scheduleSoftSerialRxFrame(value: number) {
        if (!this.cpu) return;
        const cpu = this.cpu;
        const bitCycles = this.getSoftSerialBitCycles();
        const frameStart = Math.max(cpu.cycles + 1, this.softSerialNextInjectCycle || (cpu.cycles + 1));
        const byte = value & 0xff;
        const levels: number[] = [0];
        for (let i = 0; i < 8; i++) {
            levels.push((byte >> i) & 1);
        }
        levels.push(1); // stop bit

        levels.forEach((level, index) => {
            const cycleAt = frameStart + (index * bitCycles);
            cpu.addClockEvent(() => {
                if (!this.running) return;
                this.setSoftSerialRxLevel(level === 1);
            }, cycleAt - cpu.cycles);
        });

        this.softSerialNextInjectCycle = frameStart + (levels.length * bitCycles);
    }

    private hasPendingCpuWork(): boolean {
        if (!this.cpu) return false;
        const cpuAny = this.cpu as any;
        const pendingClock = !!cpuAny?.nextClockEvent && cpuAny.nextClockEvent.cycles <= this.cpu.cycles;
        const pendingInterrupt = !!cpuAny?.interruptsEnabled && Number(cpuAny?.nextInterrupt ?? -1) >= 0;
        return pendingClock || pendingInterrupt;
    }

    private drainPendingCpuWork(maxTicks = 8) {
        if (!this.cpu) return;
        let guard = 0;
        while (this.running && this.hasPendingCpuWork() && guard < maxTicks) {
            this.cpu.tick();
            guard += 1;
        }
    }

    private shouldEmitComponentState(componentId: string, state: any, nowMs: number): boolean {
        const policy = getComponentStateSyncPolicy(state);
        const prev = this.componentSyncMeta.get(componentId);
        if (policy.minIntervalMs > 0 && prev && (nowMs - prev.lastSentAt) < policy.minIntervalMs) {
            return false;
        }
        this.componentSyncMeta.set(componentId, { lastSentAt: nowMs, lastWeight: policy.weight });
        return true;
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
                    let forcedLow = this.softSerialRxLineLow && (pin === this.softSerialRxPin || pin === `D${this.softSerialRxPin}`);
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
                        this.dispatchOptionalProtocols(pin, isHigh, this.cpu!.cycles);
                        this.observeSoftSerialTx(pin, isHigh, this.cpu!.cycles);
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
                this.drainPendingCpuWork();
            }
            this.processSoftSerialDecode(this.cpu.cycles);
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

    softSerialRxByte(value: number) {
        this.scheduleSoftSerialRxFrame(value & 0xff);
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
        this.softSerialNextInjectCycle = 0;
        this.softSerialDecodeState = {
            receiving: false,
            sampleCycle: 0,
            sampleIndex: 0,
            currentByte: 0,
            lastLevel: true,
        };
        this.setSoftSerialRxLevel(true);
        this.protocolEndpointsCache.clear();
        this.pwmState.clear();
        this.oneWireState.clear();
        this.componentSyncMeta.clear();
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

    private getArduinoPinAliases(pinId: string): string[] {
        const raw = String(pinId || '').toUpperCase();
        const out = new Set<string>([raw]);
        if (/^D\d+$/.test(raw)) {
            out.add(raw.slice(1));
        } else if (/^\d+$/.test(raw)) {
            out.add(`D${raw}`);
        }
        return Array.from(out);
    }

    private getProtocolEndpointsForArduinoPin(pinId: string): ConnectedComponentPin[] {
        const key = String(pinId || '').toUpperCase();
        const cached = this.protocolEndpointsCache.get(key);
        if (cached) return cached;

        const endpoints = collectConnectedComponentPins(
            this.boardId,
            this.getArduinoPinAliases(key),
            this.currentWires,
            this.instances
        );
        this.protocolEndpointsCache.set(key, endpoints);
        return endpoints;
    }

    private dispatchOptionalPwm(pinId: string, isHigh: boolean, cycles: number) {
        const key = String(pinId || '').toUpperCase();
        let state = this.pwmState.get(key);
        if (!state) {
            state = { lastRiseCycle: -1, lastFallCycle: -1, lastPeriodCycles: -1 };
            this.pwmState.set(key, state);
        }

        let frequencyHz = 0;
        let dutyCycle = 0;
        let pulseUs = 0;
        let periodUs = 0;

        if (isHigh) {
            if (state.lastRiseCycle >= 0 && state.lastFallCycle > state.lastRiseCycle) {
                const periodCycles = Math.max(1, cycles - state.lastRiseCycle);
                const highCycles = Math.max(0, state.lastFallCycle - state.lastRiseCycle);
                state.lastPeriodCycles = periodCycles;
                frequencyHz = 16_000_000 / periodCycles;
                dutyCycle = Math.max(0, Math.min(1, highCycles / periodCycles));
                periodUs = periodCycles / 16;
                pulseUs = highCycles / 16;
            }
            state.lastRiseCycle = cycles;
        } else {
            state.lastFallCycle = cycles;
            if (state.lastRiseCycle >= 0) {
                const highCycles = Math.max(0, cycles - state.lastRiseCycle);
                pulseUs = highCycles / 16;
                if (state.lastPeriodCycles > 0) {
                    frequencyHz = 16_000_000 / state.lastPeriodCycles;
                    dutyCycle = Math.max(0, Math.min(1, highCycles / state.lastPeriodCycles));
                    periodUs = state.lastPeriodCycles / 16;
                }
            }
        }

        if (frequencyHz <= 0 && dutyCycle <= 0 && pulseUs <= 0) return;

        const meta = {
            protocol: 'pwm',
            boardPin: key,
            isHigh,
            frequencyHz,
            dutyCycle,
            pulseUs,
            periodUs,
            source: 'gpio',
            cycles,
        };

        for (const endpoint of this.getProtocolEndpointsForArduinoPin(key)) {
            invokeOptional(endpoint.inst as any, ['onPWM', 'onPwm', 'onPWMSignal'], [endpoint.pinId, meta]);
        }
    }

    private dispatchOptionalOneWire(pinId: string, isHigh: boolean, cycles: number) {
        const key = String(pinId || '').toUpperCase();
        let state = this.oneWireState.get(key);
        if (!state) {
            state = { lowStartCycle: null, highStartCycle: null };
            this.oneWireState.set(key, state);
        }

        const endpoints = this.getProtocolEndpointsForArduinoPin(key);
        if (!endpoints.length) {
            if (isHigh) {
                state.lowStartCycle = null;
                state.highStartCycle = cycles;
            } else {
                state.highStartCycle = null;
                state.lowStartCycle = cycles;
            }
            return;
        }

        if (!isHigh) {
            if (state.highStartCycle != null) {
                const highCycles = Math.max(0, cycles - state.highStartCycle);
                const highUs = highCycles / 16;
                if (highUs > 0) {
                    const pulseMeta = {
                        protocol: 'pulse',
                        boardPin: key,
                        pulseUs: highUs,
                        highUs,
                        edge: 'falling',
                        cycles,
                    };
                    for (const endpoint of endpoints) {
                        invokeOptional(endpoint.inst as any, ['onPulseHigh', 'onDigitalPulseHigh', 'onOneWirePulseHigh'], [endpoint.pinId, pulseMeta]);
                    }
                }
            }

            state.highStartCycle = null;
            state.lowStartCycle = cycles;
            return;
        }

        if (state.lowStartCycle == null) return;

        const lowCycles = Math.max(0, cycles - state.lowStartCycle);
        state.lowStartCycle = null;
        state.highStartCycle = cycles;
        const lowUs = lowCycles / 16;

        if (lowUs > 0) {
            const pulseMeta = {
                protocol: 'pulse',
                boardPin: key,
                pulseUs: lowUs,
                lowUs,
                edge: 'rising',
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onPulseLow', 'onDigitalPulseLow', 'onOneWirePulseLow'], [endpoint.pinId, pulseMeta]);
            }
        }

        if (lowUs >= 360) {
            const meta = {
                protocol: 'onewire',
                boardPin: key,
                pulseUs: lowUs,
                kind: 'reset',
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onOneWireReset', 'onOnewireReset'], [endpoint.pinId, meta]);
            }
            return;
        }

        if (lowUs >= 1 && lowUs <= 120) {
            const bit = lowUs < 20 ? 1 : 0;
            const meta = {
                protocol: 'onewire',
                boardPin: key,
                pulseUs: lowUs,
                kind: 'slot',
                bit,
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onOneWireWriteBit', 'onOnewireWriteBit'], [endpoint.pinId, bit, meta]);
                invokeOptional(endpoint.inst as any, ['onOneWireSlot', 'onOnewireSlot'], [endpoint.pinId, meta]);
            }
        }
    }

    private dispatchOptionalProtocols(pinId: string, isHigh: boolean, cycles: number) {
        this.dispatchOptionalPwm(pinId, isHigh, cycles);
        this.dispatchOptionalOneWire(pinId, isHigh, cycles);
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

/**
 * Cycle-accurate clock for RP2040 simulation.
 * Replaces the default wall-clock based RealtimeClock to allow precise cycle-locking.
 */
class RP2040MockClock {
    private _micros = 0;
    private timers: Array<{ micros: number; callback: () => void }> = [];
    
    get micros() { return this._micros; }
    get nanos() { return this._micros * 1000; }
    
    pause() { /* Idle */ }
    resume() { /* Idle */ }
    
    createTimer(deltaMicros: number, callback: () => void) {
        const timer = { micros: this._micros + deltaMicros, callback };
        this.timers.push(timer);
        this.timers.sort((a, b) => a.micros - b.micros);
        return timer;
    }
    
    deleteTimer(timer: any) {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
    }
    
    tick(nanos: number) {
        this.advance(nanos / 1000);
    }

    advance(deltaMicros: number) {
        const targetTime = this._micros + Math.max(deltaMicros, 0);
        while (this.timers.length > 0 && this.timers[0].micros <= targetTime) {
            const timer = this.timers.shift()!;
            this._micros = timer.micros;
            timer.callback();
        }
        this._micros = targetTime;
    }

    get nanosToNextAlarm(): number {
        if (this.timers.length === 0) return -1;
        return Math.max(0, (this.timers[0].micros - this._micros) * 1000);
    }
}

export class RP2040Runner implements BoardRunner {
    cpu: RP2040 | null = null;
    gdbWs: WebSocket | null = null;
    running: boolean = false;
    pinStates: Record<string, boolean> = {};
    currentWires: any[] = [];
    instances: Map<string, BaseComponent> = new Map();
    lastTime: number = 0;
    statusInterval: any;
    pinsChanged: boolean = true;
    boardId: string;
    private serialBaudRate: number = 115200;
    private softSerialBaudRate: number = 9600;
    private serialByteBudget: number = 0;
    private readonly onStateUpdate: (state: any) => void;
    private readonly onByteTransmitCb?: (payload: { boardId: string; value: number; char: string; source?: string }) => void;
    private readonly softSerialTxPin = 'GP10';
    private readonly softSerialRxPin = 'GP11';
    private softSerialRxQueue: number[] = [];
    private softSerialRxFrame: { levels: number[]; bitIndex: number; nextBitCycle: number; bitCycles: number } | null = null;
    private softSerialRxLevelHigh = true;
    private softSerialRxOverrideActive = false;
    private softSerialNextInjectCycle = 0;
    private softSerialDecodeState = {
        receiving: false,
        sampleCycle: 0,
        sampleIndex: 0,
        currentByte: 0,
        lastLevel: true,
    };
    private readonly firmwareHex: string;
    private serialBuffer: Array<{ value: number; source: number }> = [];
    private activeUartIndex: number = 0;
    private gdbStatus: 'disabled' | 'connecting' | 'connected' | 'error' | 'closed' = 'disabled';
    private gdbLastError: string = '';
    private usbCdc: USBCDC | null = null;
    private usbCdcReady: boolean = false;
    private gpioUnsubscribers: Array<() => boolean> = [];
    private protocolEndpointsCache = new Map<string, ConnectedComponentPin[]>();
    private i2cDeviceCache = new Map<'i2c0' | 'i2c1', BaseComponent[]>();
    private spiDeviceCache = new Map<'spi0' | 'spi1', BaseComponent[]>();
    private peripheralDeviceCacheReady: boolean = false;
    private pwmState = new Map<string, { lastRiseCycle: number; lastFallCycle: number; lastPeriodCycles: number }>();
    private oneWireState = new Map<string, { lowStartCycle: number | null; highStartCycle: number | null }>();
    private componentSyncMeta = new Map<string, { lastSentAt: number; lastWeight: number }>();
    private hasFaulted: boolean = false;
    private bootromLoaded: boolean = false;
    private cpuCyclesAtStart: number = 0;
    private readonly debugEnabled: boolean;
    private readonly debugIntervalMs: number;
    private debugLastEmitAt: number = 0;
    private debugLastStepCount: number = 0;
    private debugStepCount: number = 0;
    private totalCyclesIntended: number = 0;
    private pioStepAccum: number = 0;
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
    private invalidPcStrikeCount: number = 0;
    private readonly extraExecutableRanges: RP2040ExecutableRange[];
    private readonly uartLedOffTimers = new Map<'GP0' | 'GP1' | 'GP4' | 'GP5', ReturnType<typeof setTimeout>>();
    private entryInfo: RP2040EntryInfo | null = null;
    private picoWirelessStub: {
        mode: 'off' | 'compat-stub';
        ssid: string;
        ip: string;
        status: 'off' | 'booting' | 'connected';
        startedAtMs: number;
        lastEmitMs: number;
    } | null = null;
    private static readonly FAULT_GRACE_CYCLES = 6_000_000; // ~48ms simulated @ 125MHz – covers bootrom + MicroPython init
    private static readonly LOW_PC_ALIAS_REPEAT_LIMIT = 50_000_000;
    private static readonly INVALID_PC_STRIKE_LIMIT = 64;
    private static readonly PC_VALIDATION_INTERVAL_STEPS = 1024;
    private static readonly HARD_INVALID_PC_BASE = 0x80000000;
    private static readonly SERIAL_DEDUP_WINDOW_MS = 2;
    private static readonly USB_SERIAL_PREFER_WINDOW_MS = 250;
    private static readonly UART_LED_PULSE_MS = 40;
    private static readonly WIRELESS_STUB_EMIT_INTERVAL_MS = 2000;

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
        const boardCompDef = (componentsDef || []).find((c: any) => String(c.id || '') === this.boardId) || fallbackBoard;
        this.setSerialBaudRate(options.serialBaudRate ?? 115200);
        this.debugEnabled = options.debugEnabled !== false;
        this.debugIntervalMs = Math.max(150, Number(options.debugIntervalMs || 800));
        this.extraExecutableRanges = normalizeRp2040ExecutableRanges(options.rp2040ExecutableRanges);

        this.cpu = new RP2040(new RP2040MockClock() as any);
        this.patchClockSelectedReads();
        this.cpu.loadBootrom(bootromB1);
        this.cpu.logger = new ConsoleLogger(LogLevel.Error, true);

        // -- Patch PIO to use synchronous stepping instead of redundant setTimeout --
        // This is a critical 'Velxio' optimization that prevents event-loop congestion.
        for (const pio of (this.cpu as any).pio) {
            pio.run = function(this: any) {
                if (this.runTimer) {
                    clearTimeout(this.runTimer);
                    this.runTimer = null;
                }
            };
        }
        this.pioStepAccum = 0;

        try {
            const gdbWs = new WebSocket('ws://localhost:3333');
            this.gdbStatus = 'connecting';
            this.emitGdbStatus('connecting', 'Attempting ws://localhost:3333');
            const gdbServer = new GDBServer(this.cpu);
            const gdbConn = new GDBConnection(gdbServer, (res) => {
                if (gdbWs.readyState === WebSocket.OPEN) gdbWs.send(res);
            });
            gdbWs.onopen = () => {
                this.gdbStatus = 'connected';
                this.gdbLastError = '';
                this.emitGdbStatus('connected', 'GDB bridge connected');
            };
            gdbWs.onmessage = (e) => {
                if (typeof e.data === 'string') gdbConn.feedData(e.data);
            };
            gdbWs.onerror = () => {
                this.gdbStatus = 'error';
                this.gdbLastError = 'WebSocket error';
                this.emitGdbStatus('error', this.gdbLastError);
            };
            gdbWs.onclose = (evt: any) => {
                this.gdbStatus = 'closed';
                const reason = String(evt?.reason || '').trim();
                const detail = `code=${Number(evt?.code || 0)}${reason ? ` reason=${reason}` : ''}`;
                this.emitGdbStatus('closed', detail);
            };
            this.gdbWs = gdbWs;
        } catch (err) {
            console.warn('Silent failure opening GDB Bridge ws://localhost:3333', err);
            this.gdbStatus = 'error';
            this.gdbLastError = String((err as any)?.message || err || 'Unknown GDB bridge error');
            this.emitGdbStatus('error', this.gdbLastError);
        }
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
        this.initWirelessStub(boardCompDef);

        this.attachGPIOListeners();
        this.attachUART();
        this.attachUSBSerial();
        this.rebuildPeripheralDeviceCache();
        this.installRp2040I2cAdapters();
        this.installRp2040SpiAdapters();

        // Seed default pin values as LOW so dependent components can initialize.
        for (let gp = 0; gp <= 28; gp++) {
            const pin = `GP${gp}`;
            this.pinStates[pin] = false;
            this.propagateBoardPin(pin, false);
        }
        this.setSoftSerialRxLevel(true);

        this.running = true;
        this.lastTime = performance.now();
        this.emitDebugSnapshot('start', this.lastTime, true);
        this.emitWirelessStubStatus('start', true);
        this.runLoop();

        this.statusInterval = setInterval(() => {
            if (this.running && this.cpu) {
                const msg: any = { type: 'state', boardId: this.boardId };
                let shouldEmit = false;
                const now = performance.now();
                this.emitWirelessStubStatus('tick');
                if (this.pinsChanged) {
                    msg.pins = this.pinStates;
                    this.pinsChanged = false;
                    shouldEmit = true;
                }

                const compStates: Array<{ id: string; state: any }> = [];
                for (const inst of this.instances.values()) {
                    if (!inst.stateChanged) continue;
                    const syncState = inst.getSyncState();
                    if (!this.shouldEmitComponentState(inst.id, syncState, now)) continue;
                    inst.stateChanged = false;
                    compStates.push({ id: inst.id, state: syncState });
                }

                if (compStates.length > 0) {
                    msg.components = compStates;
                    shouldEmit = true;
                }

                if (shouldEmit) {
                    this.onStateUpdate(msg);
                }
            }
        }, 1000 / 30);
    }

    private shouldEmitComponentState(componentId: string, state: any, nowMs: number): boolean {
        const policy = getComponentStateSyncPolicy(state);
        const prev = this.componentSyncMeta.get(componentId);
        if (policy.minIntervalMs > 0 && prev && (nowMs - prev.lastSentAt) < policy.minIntervalMs) {
            return false;
        }
        this.componentSyncMeta.set(componentId, { lastSentAt: nowMs, lastWeight: policy.weight });
        return true;
    }

    private initWirelessStub(boardCompDef: any) {
        const boardType = String(boardCompDef?.type || '').toLowerCase();
        if (!(boardType.includes('pico-w') || boardType.includes('picow'))) return;

        const modeRaw = String(boardCompDef?.attrs?.wirelessMode || 'compat-stub').toLowerCase();
        const mode: 'off' | 'compat-stub' = modeRaw === 'off' ? 'off' : 'compat-stub';
        const ssid = String(boardCompDef?.attrs?.wirelessSsid || 'Velxio-GUEST').trim() || 'Velxio-GUEST';
        const ip = String(boardCompDef?.attrs?.wirelessIp || '192.168.4.2').trim() || '192.168.4.2';
        const now = performance.now();

        this.picoWirelessStub = {
            mode,
            ssid,
            ip,
            status: mode === 'off' ? 'off' : 'booting',
            startedAtMs: now,
            lastEmitMs: 0,
        };
        this.applyWirelessStubStateToBoard();
    }

    private applyWirelessStubStateToBoard() {
        if (!this.picoWirelessStub) return;
        const boardInst = this.instances.get(this.boardId);
        if (!boardInst) return;

        const { mode, ssid, ip, status } = this.picoWirelessStub;
        boardInst.setState({
            wirelessMode: mode,
            wirelessStatus: status,
            wirelessConnected: mode !== 'off' && status === 'connected',
            wirelessSsid: mode === 'off' ? '' : ssid,
            wirelessIp: mode === 'off' ? '' : ip,
            wirelessNote: mode === 'off'
                ? 'Wireless compatibility stub disabled.'
                : 'Compatibility stub only. Pico W radio/network emulation is not implemented.',
        });
    }

    private emitWirelessStubStatus(reason: 'start' | 'tick' | 'reset' = 'tick', force = false) {
        if (!this.picoWirelessStub) return;

        const now = performance.now();
        if (!force && (now - this.picoWirelessStub.lastEmitMs) < RP2040Runner.WIRELESS_STUB_EMIT_INTERVAL_MS) {
            return;
        }

        if (this.picoWirelessStub.mode === 'off') {
            this.picoWirelessStub.status = 'off';
        } else {
            const elapsed = now - this.picoWirelessStub.startedAtMs;
            this.picoWirelessStub.status = elapsed >= 1200 ? 'connected' : 'booting';
        }

        this.applyWirelessStubStateToBoard();

        const connected = this.picoWirelessStub.mode !== 'off' && this.picoWirelessStub.status === 'connected';
        this.onStateUpdate({
            type: 'debug',
            boardId: this.boardId,
            category: 'rp2040-wireless-stub',
            reason,
            wireless: {
                mode: this.picoWirelessStub.mode,
                status: this.picoWirelessStub.status,
                connected,
                ssid: this.picoWirelessStub.mode === 'off' ? '' : this.picoWirelessStub.ssid,
                ip: this.picoWirelessStub.mode === 'off' ? '' : this.picoWirelessStub.ip,
                note: this.picoWirelessStub.mode === 'off'
                    ? 'Wireless compatibility stub disabled.'
                    : 'Compatibility stub only. Pico W radio/network emulation is not implemented.',
            },
        });

        this.picoWirelessStub.lastEmitMs = now;
    }

    private emitGdbStatus(reason: 'connecting' | 'connected' | 'closed' | 'error' | 'stopped', detail = '') {
        this.onStateUpdate({
            type: 'debug',
            boardId: this.boardId,
            category: 'rp2040-gdb',
            reason,
            gdb: {
                status: this.gdbStatus,
                detail: String(detail || ''),
                lastError: this.gdbLastError,
            },
        });
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
        if (pc >= RP2040_USB_RAM_BASE && pc < (RP2040_USB_RAM_BASE + RP2040_USB_RAM_SIZE)) return true;
        for (const range of this.extraExecutableRanges) {
            if (pc >= range.start && pc <= range.end) return true;
        }
        return false;
    }

    private faultAndStop(reason: string, pc: number) {
        if (this.hasFaulted) return;
        this.hasFaulted = true;
        this.running = false;
        this.clearPendingUartLedTimers();
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
                stepsSinceLastEmit: this.debugStepCount - this.debugLastStepCount,
                pcStallTicks: this.debugPcStallTicks,
                interruptsEnabled: this.cpu.core.enabledInterrupts >>> 0,
                interruptsPending: this.cpu.core.pendingInterrupts >>> 0,
                primask: !!this.cpu.core.PM,
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
        this.debugLastStepCount = this.debugStepCount;
        this.onStateUpdate(payload);
    }

    private rebaseProgramCounterAlias(stepWeight = 1) {
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
            this.invalidPcStrikeCount = 0;
            return;
        }

        // Boot ROM can be entered legitimately. Only force alias recovery when
        // execution is visibly stuck at the same low PC for many consecutive steps.
        const repeatIncrement = Math.max(1, stepWeight | 0);
        if (this.lowPcAliasCandidate === pc) {
            this.lowPcAliasRepeatCount += repeatIncrement;
        } else {
            this.lowPcAliasCandidate = pc;
            this.lowPcAliasRepeatCount = 0;
        }

        // Only force rebase if we are stuck at the EXACT same PC for a long time.
        // Also don't rebase if we are at address 0 (waiting for something) or in a wait state.
        if (this.lowPcAliasRepeatCount >= RP2040Runner.LOW_PC_ALIAS_REPEAT_LIMIT && pc !== 0) {
            this.cpu.core.BXWritePC(rebased);
            this.lowPcAliasRepeatCount = 0;
            this.invalidPcStrikeCount = 0;
        }
    }

    private shouldFaultForInvalidPc(pc: number): boolean {
        if (!this.cpu) return false;
        const stepPc = pc >>> 0;
        const cyclesSinceStart = (this.cpu.core.cycles - this.cpuCyclesAtStart) >>> 0;
        const pastGracePeriod = cyclesSinceStart > RP2040Runner.FAULT_GRACE_CYCLES;
        const hardInvalidPc = stepPc >= RP2040Runner.HARD_INVALID_PC_BASE;
        const recoveringLowAlias = !hardInvalidPc
            && this.lowPcAliasCandidate === stepPc
            && this.lowPcAliasRepeatCount > 0;

        if (recoveringLowAlias) {
            this.invalidPcStrikeCount = 0;
            return false;
        }

        const invalidPc = (pastGracePeriod || hardInvalidPc) && !this.isExecutableAddress(stepPc);

        if (invalidPc) {
            this.invalidPcStrikeCount += 1;
        } else {
            this.invalidPcStrikeCount = 0;
        }

        return this.invalidPcStrikeCount >= RP2040Runner.INVALID_PC_STRIKE_LIMIT;
    }

    private getSoftSerialBitCycles(): number {
        const baud = Math.max(300, this.softSerialBaudRate | 0);
        const clockHz = this.getRp2040ClockHz();
        return Math.max(1, Math.floor(clockHz / baud));
    }

    private setSoftSerialRxLevel(isHigh: boolean) {
        this.softSerialRxLevelHigh = isHigh;
        this.cpu?.gpio?.[11]?.setInputValue(isHigh);
    }

    private emitSoftSerialByte(value: number) {
        const byte = value & 0xff;
        const char = String.fromCharCode(byte);
        this.debugSerialTxBytes += 1;
        this.pulseBoardUartLed('GP0');
        if (this.onByteTransmitCb) {
            this.onByteTransmitCb({ boardId: this.boardId, value: byte, char, source: 'softserial' });
        } else {
            this.onStateUpdate({ type: 'serial', data: char, value: byte, boardId: this.boardId, source: 'softserial' });
        }
    }

    private processSoftSerialDecode(cycles: number) {
        const state = this.softSerialDecodeState;
        if (!state.receiving) return;
        const bitCycles = this.getSoftSerialBitCycles();

        while (state.receiving && state.sampleCycle <= cycles) {
            if (state.sampleIndex < 8) {
                if (state.lastLevel) {
                    state.currentByte |= (1 << state.sampleIndex);
                }
                state.sampleIndex += 1;
                state.sampleCycle += bitCycles;
                continue;
            }

            // Stop bit: valid frame when line is HIGH.
            if (state.lastLevel) {
                this.emitSoftSerialByte(state.currentByte);
            }
            state.receiving = false;
            state.sampleIndex = 0;
            state.currentByte = 0;
        }
    }

    private observeSoftSerialTx(pinId: string, isHigh: boolean, cycles: number) {
        if (this.normalizeToGpPin(pinId) !== this.softSerialTxPin) return;
        const state = this.softSerialDecodeState;

        this.processSoftSerialDecode(cycles);

        const prev = state.lastLevel;
        state.lastLevel = isHigh;

        // Falling edge while idle => start bit.
        if (!state.receiving && prev && !isHigh) {
            const bitCycles = this.getSoftSerialBitCycles();
            state.receiving = true;
            state.currentByte = 0;
            state.sampleIndex = 0;
            state.sampleCycle = cycles + (bitCycles * 1.5);
        }
    }

    private advanceSoftSerialIngress(cycles: number) {
        if (!this.cpu) return;

        if (!this.softSerialRxFrame && this.softSerialRxQueue.length > 0) {
            const byte = this.softSerialRxQueue.shift()! & 0xff;
            const bitCycles = this.getSoftSerialBitCycles();
            const startCycle = Math.max(cycles + 1, this.softSerialNextInjectCycle || (cycles + 1));
            const levels: number[] = [0];
            for (let i = 0; i < 8; i++) {
                levels.push((byte >> i) & 1);
            }
            levels.push(1);
            this.softSerialRxFrame = {
                levels,
                bitIndex: 0,
                nextBitCycle: startCycle,
                bitCycles,
            };
            this.softSerialNextInjectCycle = startCycle + (levels.length * bitCycles);
            this.softSerialRxOverrideActive = true;
        }

        while (this.softSerialRxFrame && cycles >= this.softSerialRxFrame.nextBitCycle) {
            const frame = this.softSerialRxFrame;
            const level = frame.levels[frame.bitIndex] === 1;
            this.setSoftSerialRxLevel(level);
            frame.bitIndex += 1;
            frame.nextBitCycle += frame.bitCycles;

            if (frame.bitIndex >= frame.levels.length) {
                this.softSerialRxFrame = null;
                break;
            }
        }

        if (!this.softSerialRxFrame && this.softSerialRxQueue.length === 0 && this.softSerialRxOverrideActive) {
            this.setSoftSerialRxLevel(true);
            this.softSerialRxOverrideActive = false;
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

    private buildBoardAliasSet(boardPins: string[]): Set<string> {
        const aliases = new Set<string>();
        for (const pin of boardPins) {
            const raw = String(pin || '').toUpperCase();
            aliases.add(raw);
            aliases.add(this.normalizeToGpPin(raw));
        }
        return aliases;
    }

    private findExistingPinName(inst: BaseComponent, candidates: string[]): string | null {
        for (const name of candidates) {
            if (inst.pins[name]) return name;
            const upper = name.toUpperCase();
            if (inst.pins[upper]) return upper;
            const lower = name.toLowerCase();
            if (inst.pins[lower]) return lower;
        }
        return null;
    }

    private isComponentPinConnectedToBoardPins(componentId: string, componentPin: string, boardPins: string[]): boolean {
        const aliases = this.buildBoardAliasSet(boardPins);
        const endpoint = `${componentId}:${componentPin}`;

        for (const wire of this.currentWires) {
            let boardEndpoint: string | null = null;
            if (wire.from === endpoint) boardEndpoint = wire.to;
            else if (wire.to === endpoint) boardEndpoint = wire.from;
            if (!boardEndpoint) continue;

            const [boardId, boardPin] = String(boardEndpoint).split(':');
            if (boardId !== this.boardId) continue;

            const raw = String(boardPin || '').toUpperCase();
            const normalized = this.normalizeToGpPin(raw);
            if (aliases.has(raw) || aliases.has(normalized)) {
                return true;
            }
        }

        return false;
    }

    private rebuildPeripheralDeviceCache() {
        this.i2cDeviceCache.set('i2c0', this.scanRp2040ConnectedI2CDevices('i2c0'));
        this.i2cDeviceCache.set('i2c1', this.scanRp2040ConnectedI2CDevices('i2c1'));
        this.spiDeviceCache.set('spi0', this.scanRp2040ConnectedSPIDevices('spi0'));
        this.spiDeviceCache.set('spi1', this.scanRp2040ConnectedSPIDevices('spi1'));
        this.peripheralDeviceCacheReady = true;
    }

    private getRp2040ConnectedI2CDevices(bus: 'i2c0' | 'i2c1'): BaseComponent[] {
        if (!this.peripheralDeviceCacheReady) {
            this.rebuildPeripheralDeviceCache();
        }
        const wiredDevices = this.i2cDeviceCache.get(bus) || [];
        if (wiredDevices.length > 0) {
            return wiredDevices;
        }

        // Fallback: if bus-pin topology detection misses a supported device,
        // allow address-based matching to keep common display modules functional.
        return this.getI2CCallbackDevices();
    }

    private getI2CCallbackDevices(): BaseComponent[] {
        const devices: BaseComponent[] = [];
        for (const inst of this.instances.values()) {
            const hasI2cCallbacks = !!(
                inst.onI2CStart
                || inst.onI2CByte
                || inst.onI2CStop
                || typeof (inst as any).onI2CReadByte === 'function'
                || typeof (inst as any).readByte === 'function'
            );
            if (hasI2cCallbacks) {
                devices.push(inst);
            }
        }
        return devices;
    }

    private scanRp2040ConnectedI2CDevices(bus: 'i2c0' | 'i2c1'): BaseComponent[] {
        const pinMap = RP2040_I2C_SOURCE_PINS[bus];
        if (!pinMap) return [];

        const devices: BaseComponent[] = [];
        for (const inst of this.instances.values()) {
            const hasI2cCallbacks = !!(
                inst.onI2CStart
                || inst.onI2CByte
                || inst.onI2CStop
                || typeof (inst as any).onI2CReadByte === 'function'
                || typeof (inst as any).readByte === 'function'
            );
            if (!hasI2cCallbacks) continue;

            const sdaPin = this.findExistingPinName(inst, ['SDA', 'SDA1']);
            const sclPin = this.findExistingPinName(inst, ['SCL', 'SCL1']);
            if (!sdaPin || !sclPin) continue;

            const sdaConnected = this.isComponentPinConnectedToBoardPins(inst.id, sdaPin, pinMap.sda);
            const sclConnected = this.isComponentPinConnectedToBoardPins(inst.id, sclPin, pinMap.scl);
            if (sdaConnected && sclConnected) {
                devices.push(inst);
            }
        }

        return devices;
    }

    private isRp2040SpiSelected(inst: BaseComponent): boolean {
        const csNames = ['CS', 'CE', 'SS', 'SSEL', 'NSS', 'CSN', 'CS_N', 'NCE'];
        const csPin = this.findExistingPinName(inst, csNames);
        if (!csPin) return true;
        return inst.getPinVoltage(csPin) < 0.5;
    }

    private parseGpIndex(pinId: string): number | null {
        const norm = this.normalizeToGpPin(pinId);
        const match = /^GP(\d+)$/.exec(norm);
        if (!match) return null;
        const idx = Number(match[1]);
        if (!Number.isFinite(idx) || idx < 0 || idx > 28) return null;
        return idx;
    }

    private sampleBoardPinHigh(pinId: string): boolean {
        if (!this.cpu) return false;
        const idx = this.parseGpIndex(pinId);
        if (idx == null) return false;
        const state = this.cpu.gpio[idx].value;
        return state === GPIOPinState.High || state === GPIOPinState.InputPullUp;
    }

    private resolveBoardPinForComponentPin(componentId: string, componentPin: string): string | null {
        const endpoint = `${componentId}:${componentPin}`;
        for (const wire of this.currentWires) {
            let boardEndpoint: string | null = null;
            if (wire.from === endpoint) boardEndpoint = wire.to;
            else if (wire.to === endpoint) boardEndpoint = wire.from;
            if (!boardEndpoint) continue;

            const [boardId, boardPin] = String(boardEndpoint).split(':');
            if (boardId !== this.boardId) continue;
            return this.normalizeToGpPin(String(boardPin || ''));
        }
        return null;
    }

    private syncSpiControlPins(inst: BaseComponent) {
        if (!this.cpu) return;

        const controlAliases = [
            ['CS', 'CE', 'SS', 'SSEL', 'NSS', 'CSN', 'CS_N', 'NCE'],
            ['DC', 'D_C', 'A0', 'RS'],
            ['RESET', 'RST', 'RES', 'NRST'],
        ];

        for (const aliases of controlAliases) {
            const pinName = this.findExistingPinName(inst, aliases);
            if (!pinName) continue;

            const gpPin = this.resolveBoardPinForComponentPin(inst.id, pinName);
            if (!gpPin) continue;

            const isHigh = this.sampleBoardPinHigh(gpPin);
            const nextVoltage = isHigh ? 3.3 : 0.0;
            if (!inst.pins[pinName]) {
                inst.pins[pinName] = { voltage: nextVoltage, mode: 'INPUT' };
            }
            inst.setPinVoltage(pinName, nextVoltage);
            inst.onPinStateChange(pinName, isHigh, this.cpu.core.cycles);
        }
    }

    private getRp2040ConnectedSPIDevices(bus: 'spi0' | 'spi1'): BaseComponent[] {
        if (!this.peripheralDeviceCacheReady) {
            this.rebuildPeripheralDeviceCache();
        }
        return this.spiDeviceCache.get(bus) || [];
    }

    private scanRp2040ConnectedSPIDevices(bus: 'spi0' | 'spi1'): BaseComponent[] {
        const pinMap = RP2040_SPI_SOURCE_PINS[bus];
        if (!pinMap) return [];

        const devices: BaseComponent[] = [];
        for (const inst of this.instances.values()) {
            if (typeof inst.onSPIByte !== 'function') continue;

            const mosiPin = this.findExistingPinName(inst, ['MOSI', 'DIN', 'SI', 'SDI']);
            const sckPin = this.findExistingPinName(inst, ['SCK', 'CLK', 'SCLK']);
            if (!mosiPin || !sckPin) continue;

            if (!this.isComponentPinConnectedToBoardPins(inst.id, mosiPin, pinMap.mosi)) continue;
            if (!this.isComponentPinConnectedToBoardPins(inst.id, sckPin, pinMap.sck)) continue;

            const csPin = this.findExistingPinName(inst, ['CS', 'SS', 'CSN', 'NSS', 'CE', 'CS_N']);
            if (csPin && !this.isComponentPinConnectedToBoardPins(inst.id, csPin, pinMap.cs)) {
                continue;
            }

            devices.push(inst);
        }

        return devices;
    }

    private installRp2040I2cAdapters() {
        if (!this.cpu) return;

        const attachBus = (index: 0 | 1, bus: 'i2c0' | 'i2c1') => {
            const i2c: any = (this.cpu as any)?.i2c?.[index];
            if (!i2c) return;

            let activeSlave: BaseComponent | null = null;

            i2c.onStart = (repeatedStart: boolean) => {
                void repeatedStart;
                activeSlave = null;
                i2c.completeStart();
            };

            i2c.onConnect = (address: number, mode: number) => {
                const isRead = Number(mode) === 1;
                const devices = this.getRp2040ConnectedI2CDevices(bus);
                let ack = false;
                activeSlave = null;

                for (const inst of devices) {
                    if (!inst.onI2CStart) continue;
                    if (inst.onI2CStart(address, isRead)) {
                        ack = true;
                        if (!activeSlave) activeSlave = inst;
                    }
                }

                i2c.completeConnect(ack);

                if (this.debugEnabled) {
                    this.onStateUpdate({
                        type: 'debug',
                        boardId: this.boardId,
                        category: 'rp2040-i2c',
                        reason: 'connect',
                        i2c: {
                            bus,
                            address: address & 0x7f,
                            isRead,
                            ack,
                            deviceCount: devices.length,
                            activeSlaveId: activeSlave?.id || '',
                        },
                    });
                }
            };

            i2c.onWriteByte = (value: number) => {
                const devices = activeSlave ? [activeSlave] : this.getRp2040ConnectedI2CDevices(bus);
                let ack = false;
                for (const inst of devices) {
                    if (!inst.onI2CByte) continue;
                    if (inst.onI2CByte(-1, value & 0xff)) {
                        ack = true;
                    }
                }
                i2c.completeWrite(ack);
            };

            i2c.onReadByte = (ack: boolean) => {
                void ack;
                let byte = 0xff;
                if (activeSlave) {
                    const slave: any = activeSlave;
                    if (typeof slave.onI2CReadByte === 'function') {
                        byte = slave.onI2CReadByte() & 0xff;
                    } else if (typeof slave.readByte === 'function') {
                        byte = slave.readByte() & 0xff;
                    }
                }
                i2c.completeRead(byte);
            };

            i2c.onStop = () => {
                const devices = activeSlave ? [activeSlave] : this.getRp2040ConnectedI2CDevices(bus);
                for (const inst of devices) {
                    if (inst.onI2CStop) inst.onI2CStop();
                }
                activeSlave = null;
                i2c.completeStop();
            };
        };

        attachBus(0, 'i2c0');
        attachBus(1, 'i2c1');
    }

    private installRp2040SpiAdapters() {
        if (!this.cpu) return;

        const attachBus = (index: 0 | 1, bus: 'spi0' | 'spi1') => {
            const spi: any = (this.cpu as any)?.spi?.[index];
            if (!spi) return;

            // rp2040js SPI doTX currently sets busy=true after invoking onTransmit().
            // Under high-throughput writes this can stall and/or drop bytes because
            // firmware keeps writing while TX stays artificially busy. Patch doTX once
            // so busy is asserted before callback, then cleared by completeTransmit().
            if (!spi.__openhwPatchedDoTX && typeof spi.doTX === 'function' && spi.txFIFO) {
                spi.__openhwPatchedDoTX = true;
                spi.doTX = function patchedDoTX(this: any) {
                    if (!this.busy && !this.txFIFO.empty) {
                        const value = this.txFIFO.pull();
                        this.busy = true;
                        this.onTransmit(value);
                        this.fifosUpdated();
                    }
                };
            }

            spi.onTransmit = (value: number) => {
                const byte = value & 0xff;
                let response = 0xff;
                const devices = this.getRp2040ConnectedSPIDevices(bus);

                for (const inst of devices) {
                    this.syncSpiControlPins(inst);
                    if (!this.isRp2040SpiSelected(inst)) continue;
                    const out = inst.onSPIByte?.(byte);
                    if (out !== undefined) {
                        response = Number(out) & 0xff;
                    }
                }

                spi.completeTransmit(response);
            };
        };

        attachBus(0, 'spi0');
        attachBus(1, 'spi1');
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
        this.pulseBoardUartLed(source === 1 ? 'GP4' : 'GP0');
        const sourceLabel = source === 2 ? 'usb' : source === 1 ? 'uart1' : 'uart0';

        if (this.onByteTransmitCb) {
            this.onByteTransmitCb({ boardId: this.boardId, value: byte, char, source: sourceLabel });
        } else {
            this.onStateUpdate({ type: 'serial', data: char, value: byte, boardId: this.boardId, source: sourceLabel });
        }
    }

    private pulseBoardUartLed(pinId: 'GP0' | 'GP1' | 'GP4' | 'GP5') {
        const boardInst = this.instances.get(this.boardId);
        if (!boardInst || !this.cpu) return;
        boardInst.onPinStateChange(pinId, true, this.cpu.core.cycles);

        const previousTimer = this.uartLedOffTimers.get(pinId);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const offTimer = setTimeout(() => {
            this.uartLedOffTimers.delete(pinId);
            if (!this.cpu) return;
            const liveBoardInst = this.instances.get(this.boardId);
            if (!liveBoardInst) return;
            liveBoardInst.onPinStateChange(pinId, false, this.cpu.core.cycles);
        }, RP2040Runner.UART_LED_PULSE_MS);
        this.uartLedOffTimers.set(pinId, offTimer);
    }

    private clearPendingUartLedTimers() {
        for (const timerId of this.uartLedOffTimers.values()) {
            clearTimeout(timerId);
        }
        this.uartLedOffTimers.clear();
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

    private getRp2040ClockHz(): number {
        const hz = Number(this.cpu?.clkSys || 125_000_000);
        return Number.isFinite(hz) && hz > 0 ? hz : 125_000_000;
    }

    private getProtocolEndpointsForGpPin(gpPin: string): ConnectedComponentPin[] {
        const key = this.normalizeToGpPin(gpPin);
        const cached = this.protocolEndpointsCache.get(key);
        if (cached) return cached;

        const endpoints = collectConnectedComponentPins(
            this.boardId,
            this.boardPinAliases(key),
            this.currentWires,
            this.instances
        );
        this.protocolEndpointsCache.set(key, endpoints);
        return endpoints;
    }

    private dispatchOptionalPwm(gpPin: string, isHigh: boolean, cycles: number, functionSelect: number) {
        const key = this.normalizeToGpPin(gpPin);
        let state = this.pwmState.get(key);
        if (!state) {
            state = { lastRiseCycle: -1, lastFallCycle: -1, lastPeriodCycles: -1 };
            this.pwmState.set(key, state);
        }

        const clockHz = this.getRp2040ClockHz();
        let frequencyHz = 0;
        let dutyCycle = 0;
        let pulseUs = 0;
        let periodUs = 0;

        if (isHigh) {
            if (state.lastRiseCycle >= 0 && state.lastFallCycle > state.lastRiseCycle) {
                const periodCycles = Math.max(1, cycles - state.lastRiseCycle);
                const highCycles = Math.max(0, state.lastFallCycle - state.lastRiseCycle);
                state.lastPeriodCycles = periodCycles;
                frequencyHz = clockHz / periodCycles;
                dutyCycle = Math.max(0, Math.min(1, highCycles / periodCycles));
                periodUs = (periodCycles * 1_000_000) / clockHz;
                pulseUs = (highCycles * 1_000_000) / clockHz;
            }
            state.lastRiseCycle = cycles;
        } else {
            state.lastFallCycle = cycles;
            if (state.lastRiseCycle >= 0) {
                const highCycles = Math.max(0, cycles - state.lastRiseCycle);
                pulseUs = (highCycles * 1_000_000) / clockHz;
                if (state.lastPeriodCycles > 0) {
                    frequencyHz = clockHz / state.lastPeriodCycles;
                    dutyCycle = Math.max(0, Math.min(1, highCycles / state.lastPeriodCycles));
                    periodUs = (state.lastPeriodCycles * 1_000_000) / clockHz;
                }
            }
        }

        if (frequencyHz <= 0 && dutyCycle <= 0 && pulseUs <= 0) return;

        const meta = {
            protocol: 'pwm',
            boardPin: key,
            isHigh,
            frequencyHz,
            dutyCycle,
            pulseUs,
            periodUs,
            functionSelect,
            source: functionSelect === RP2040_GPIO_FUNC_PWM ? 'pwm' : 'gpio',
            cycles,
        };

        for (const endpoint of this.getProtocolEndpointsForGpPin(key)) {
            invokeOptional(endpoint.inst as any, ['onPWM', 'onPwm', 'onPWMSignal'], [endpoint.pinId, meta]);
        }
    }

    private dispatchOptionalPio(gpPin: string, isHigh: boolean, cycles: number, functionSelect: number) {
        if (functionSelect !== RP2040_GPIO_FUNC_PIO0 && functionSelect !== RP2040_GPIO_FUNC_PIO1) {
            return;
        }

        const key = this.normalizeToGpPin(gpPin);
        const pioIndex = functionSelect === RP2040_GPIO_FUNC_PIO1 ? 1 : 0;
        const meta = {
            protocol: 'pio',
            boardPin: key,
            isHigh,
            pioIndex,
            functionSelect,
            cycles,
        };

        for (const endpoint of this.getProtocolEndpointsForGpPin(key)) {
            invokeOptional(endpoint.inst as any, ['onPIOPinChange', 'onPioPinChange', 'onPIO', 'onPio'], [endpoint.pinId, isHigh, meta]);
        }
    }

    private dispatchOptionalOneWire(gpPin: string, isHigh: boolean, cycles: number) {
        const key = this.normalizeToGpPin(gpPin);
        let state = this.oneWireState.get(key);
        if (!state) {
            state = { lowStartCycle: null, highStartCycle: null };
            this.oneWireState.set(key, state);
        }

        const endpoints = this.getProtocolEndpointsForGpPin(key);
        if (!endpoints.length) {
            if (isHigh) {
                state.lowStartCycle = null;
                state.highStartCycle = cycles;
            } else {
                state.highStartCycle = null;
                state.lowStartCycle = cycles;
            }
            return;
        }

        const clockHz = this.getRp2040ClockHz();

        if (!isHigh) {
            if (state.highStartCycle != null) {
                const highCycles = Math.max(0, cycles - state.highStartCycle);
                const highUs = (highCycles * 1_000_000) / clockHz;
                if (highUs > 0) {
                    const pulseMeta = {
                        protocol: 'pulse',
                        boardPin: key,
                        pulseUs: highUs,
                        highUs,
                        edge: 'falling',
                        cycles,
                    };
                    for (const endpoint of endpoints) {
                        invokeOptional(endpoint.inst as any, ['onPulseHigh', 'onDigitalPulseHigh', 'onOneWirePulseHigh'], [endpoint.pinId, pulseMeta]);
                    }
                }
            }

            state.highStartCycle = null;
            state.lowStartCycle = cycles;
            return;
        }

        if (state.lowStartCycle == null) return;

        const lowCycles = Math.max(0, cycles - state.lowStartCycle);
        state.lowStartCycle = null;
        state.highStartCycle = cycles;
        const lowUs = (lowCycles * 1_000_000) / clockHz;

        if (lowUs > 0) {
            const pulseMeta = {
                protocol: 'pulse',
                boardPin: key,
                pulseUs: lowUs,
                lowUs,
                edge: 'rising',
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onPulseLow', 'onDigitalPulseLow', 'onOneWirePulseLow'], [endpoint.pinId, pulseMeta]);
            }
        }

        if (lowUs >= 360) {
            const meta = {
                protocol: 'onewire',
                boardPin: key,
                pulseUs: lowUs,
                kind: 'reset',
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onOneWireReset', 'onOnewireReset'], [endpoint.pinId, meta]);
            }
            return;
        }

        if (lowUs >= 1 && lowUs <= 120) {
            const bit = lowUs < 20 ? 1 : 0;
            const meta = {
                protocol: 'onewire',
                boardPin: key,
                pulseUs: lowUs,
                kind: 'slot',
                bit,
                cycles,
            };
            for (const endpoint of endpoints) {
                invokeOptional(endpoint.inst as any, ['onOneWireWriteBit', 'onOnewireWriteBit'], [endpoint.pinId, bit, meta]);
                invokeOptional(endpoint.inst as any, ['onOneWireSlot', 'onOnewireSlot'], [endpoint.pinId, meta]);
            }
        }
    }

    private dispatchOptionalProtocols(gpPin: string, isHigh: boolean, cycles: number, functionSelect: number) {
        this.dispatchOptionalPwm(gpPin, isHigh, cycles, functionSelect);
        this.dispatchOptionalPio(gpPin, isHigh, cycles, functionSelect);
        this.dispatchOptionalOneWire(gpPin, isHigh, cycles);
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
                const isHigh = state === GPIOPinState.High || state === GPIOPinState.InputPullUp;
                if (this.pinStates[pinName] !== isHigh) {
                    this.pinStates[pinName] = isHigh;
                    this.pinsChanged = true;
                    this.debugGpioTransitions += 1;
                    this.debugLastGpioPin = pinName;
                    const functionSelect = this.cpu?.gpio?.[gp]?.functionSelect ?? 0;
                    const boardInst = this.instances.get(this.boardId);
                    if (boardInst && this.cpu) {
                        boardInst.onPinStateChange(pinName, isHigh, this.cpu.core.cycles);
                    }
                    if (this.cpu) {
                        this.dispatchOptionalProtocols(pinName, isHigh, this.cpu.core.cycles, functionSelect);
                    }
                    this.propagateBoardPin(pinName, isHigh);
                    if (this.cpu) {
                        this.observeSoftSerialTx(pinName, isHigh, this.cpu.core.cycles);
                    }
                }
            });
            this.gpioUnsubscribers.push(unsubscribe);
        }
    }

    private updateGPIOInputsFromCircuit() {
        if (!this.cpu) return;

        for (let gp = 0; gp < 29; gp++) {
            const gpPin = `GP${gp}`;
            let observedVoltage = 0;

            const endpoints = this.getProtocolEndpointsForGpPin(gpPin);
            for (const ep of endpoints) {
                observedVoltage = Math.max(observedVoltage, ep.inst.getPinVoltage(ep.pinId));
            }

            if (gpPin === this.softSerialRxPin && this.softSerialRxOverrideActive) {
                this.cpu.gpio[gp].setInputValue(this.softSerialRxLevelHigh);
                continue;
            }

            this.cpu.gpio[gp].setInputValue(observedVoltage > 1.65);
        }
    }

    private runLoop = () => {
        if (!this.running || !this.cpu) return;

        const { core } = this.cpu;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clock = (this.cpu as any).clock;
        const F_CPU = 125_000_000;
        const CYCLE_NANOS = 1e9 / F_CPU;
        const CYCLES_PER_FRAME = Math.floor(F_CPU / 60); // 2,083,333 cycles @ 125MHz/60fps

        let cyclesDone = 0;
        const now = performance.now();

        try {
            const pioDiv = this.getPIOClockDiv();
            const executeOneInstruction = () => {
                const before = this.cpu!.core.cycles >>> 0;
                core.executeInstruction();
                const after = this.cpu!.core.cycles >>> 0;
                const delta = (after - before) >>> 0;
                return delta > 0 ? delta : 1;
            };

            // DETERMINISTIC CYCLE-TARGETED LOOP (Velxio Pattern)
            while (cyclesDone < CYCLES_PER_FRAME && this.running && this.cpu) {
                if (core.waiting && clock) {
                    const rawJumpNanos = Number(clock.nanosToNextAlarm);
                    const jumpNanos = Number.isFinite(rawJumpNanos) ? rawJumpNanos : -1;
                    if (jumpNanos <= 0) {
                        // No pending alarm while waiting: execute one instruction so WFE/WFI
                        // paths can still progress without stalling startup indefinitely.
                        const cycles = executeOneInstruction();
                        clock.tick(cycles * CYCLE_NANOS);
                        cyclesDone += cycles;
                        this.debugStepCount += 1;
                        this.pioStepAccum += cycles;
                        if (this.pioStepAccum >= pioDiv) {
                            while (this.pioStepAccum >= pioDiv) {
                                this.pioStepAccum -= pioDiv;
                                this.stepPIO();
                            }
                        }
                        continue;
                    }

                    // Incremental Jump with PIO Sync (Velxio logic)
                    const jumpedCycles = Math.ceil(jumpNanos / CYCLE_NANOS);
                    const pioSteps = Math.floor(jumpedCycles / pioDiv);
                    const nanosPerPioStep = pioDiv * CYCLE_NANOS;
                    
                    // Cap to 50k steps to prevent host stalls
                    const maxSteps = Math.min(pioSteps, 50000);
                    let nanosStepped = 0;
                    for (let i = 0; i < maxSteps; i++) {
                        clock.tick(nanosPerPioStep);
                        nanosStepped += nanosPerPioStep;
                        this.stepPIO();
                    }

                    const remaining = jumpNanos - nanosStepped;
                    if (remaining > 0) {
                        clock.tick(remaining);
                    }
                    cyclesDone += Number.isFinite(jumpedCycles) && jumpedCycles > 0 ? jumpedCycles : 0;
                } else {
                    const cycles = executeOneInstruction();
                    if (clock) clock.tick(cycles * CYCLE_NANOS);
                    cyclesDone += cycles;
                    this.debugStepCount += 1;

                    // Synchronous PIO stepping
                    this.pioStepAccum += cycles;
                    while (this.pioStepAccum >= pioDiv) {
                        this.pioStepAccum -= pioDiv;
                        this.stepPIO();
                    }
                }
            }

            // Sync peripherals and UI once per frame
            this.updateGPIOInputsFromCircuit();
            this.rebaseProgramCounterAlias(cyclesDone);

            const sampledPc = this.cpu.core.PC >>> 0;
            if (this.shouldFaultForInvalidPc(sampledPc)) {
                this.faultAndStop('Execution jumped outside valid memory', sampledPc);
                return;
            }

            // Process budgets and monitor sync
            if (this.softSerialDecodeState.receiving || this.softSerialRxFrame || this.softSerialRxQueue.length > 0) {
                const currentTotalCycles = Number(this.cpu.core.cycles);
                this.advanceSoftSerialIngress(currentTotalCycles);
                this.processSoftSerialDecode(currentTotalCycles);
            }

            const frameTimeMs = 16.6; 
            const bytesPerMs = this.serialBaudRate / 10000;
            this.serialByteBudget += frameTimeMs * bytesPerMs; 

            const uart0 = this.cpu.uart[0];
            const uart1 = this.cpu.uart[1];
            if (this.serialBuffer.length > 0 && this.serialByteBudget >= 1) {
                const maxBytes = Math.floor(this.serialByteBudget);
                let sent = 0;
                for (let i = 0; i < maxBytes && this.serialBuffer.length > 0; i++) {
                    const packet = this.serialBuffer[0]!;
                    const delivered = ((packet.source === 1 ? uart1 : uart0) || uart0).feedByte(packet.value & 0xff);
                    if (!delivered) break;
                    this.serialBuffer.shift();
                    sent += 1;
                }
                this.serialByteBudget -= sent;
            }

            const instArray = Array.from(this.instances.values());
            instArray.forEach((inst) => inst.update(this.cpu!.core.cycles, this.currentWires, instArray));

        } catch (err: any) {
            const message = String(err?.message || err || 'RP2040 execution error');
            this.faultAndStop(message, this.cpu.core.PC >>> 0);
            return;
        }

        if (this.running) {
            this.emitDebugSnapshot('tick', now);
            this.lastTime = now;
            setTimeout(this.runLoop, 0);
        }
    };

    /**
     * Step PIO state machines synchronously.
     * Replaces the redundant internal PIO timers that cause event-loop congestion.
     */
    private stepPIO(): void {
        if (!this.cpu) return;
        const pio = (this.cpu as any).pio;
        if (pio[0]) pio[0].step();
        if (pio[1]) pio[1].step();
    }

    serialRx(data: string) {
        const source = (this.usbCdc && this.usbCdcReady)
            ? 2
            : (this.activeUartIndex === 1 ? 1 : 0);
        for (let i = 0; i < data.length; i++) {
            this.serialBuffer.push({ value: data.charCodeAt(i) & 0xff, source });
            this.debugSerialRxBytes += 1;
        }
        this.pulseBoardUartLed(source === 1 ? 'GP5' : 'GP1');
    }

    serialRxByte(value: number) {
        this.serialRxByteFromSource(value, this.activeUartIndex === 1 ? 'uart1' : 'uart0');
    }

    softSerialRxByte(value: number) {
        this.softSerialRxQueue.push(value & 0xff);
        this.softSerialRxOverrideActive = true;
        this.debugSerialRxBytes += 1;
        this.pulseBoardUartLed('GP1');
    }

    serialRxByteFromSource(value: number, sourceLabel = 'uart0') {
        const s = String(sourceLabel || 'uart0').toLowerCase();
        if (isSoftSerialSourceLabel(s)) {
            this.softSerialRxByte(value);
            return;
        }
        const source = s === 'uart1' || s === 'serial1' || s === '1'
            ? 1
            : s === 'usb' || s === 'cdc' || s === 'serialusb'
                ? 2
                : 0;
        this.activeUartIndex = source;
        this.serialBuffer.push({ value: value & 0xff, source });
        this.debugSerialRxBytes += 1;
        this.pulseBoardUartLed(source === 1 ? 'GP5' : 'GP1');
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
        this.clearPendingUartLedTimers();
        this.cpu.reset();
        this.cpu.loadBootrom(bootromB1);
        this.bootromLoaded = true;
        this.entryInfo = loadRP2040Firmware(this.cpu, this.firmwareHex);
        this.serialBuffer = [];
        this.serialByteBudget = 0;
        this.activeUartIndex = 0;
        this.softSerialRxQueue = [];
        this.softSerialRxFrame = null;
        this.softSerialRxOverrideActive = false;
        this.softSerialNextInjectCycle = 0;
        this.softSerialDecodeState = {
            receiving: false,
            sampleCycle: 0,
            sampleIndex: 0,
            currentByte: 0,
            lastLevel: true,
        };
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
        this.invalidPcStrikeCount = 0;
        this.pinsChanged = true;
        this.hasFaulted = false;
        this.protocolEndpointsCache.clear();
        this.i2cDeviceCache.clear();
        this.spiDeviceCache.clear();
        this.peripheralDeviceCacheReady = false;
        this.pwmState.clear();
        this.oneWireState.clear();
        this.componentSyncMeta.clear();
        this.setSoftSerialRxLevel(true);
        this.attachUART();
        this.attachUSBSerial();
        this.rebuildPeripheralDeviceCache();
        this.installRp2040I2cAdapters();
        this.installRp2040SpiAdapters();
        if (this.picoWirelessStub) {
            const now = performance.now();
            this.picoWirelessStub.startedAtMs = now;
            this.picoWirelessStub.lastEmitMs = 0;
            this.picoWirelessStub.status = this.picoWirelessStub.mode === 'off' ? 'off' : 'booting';
            this.applyWirelessStubStateToBoard();
        }
        this.emitDebugSnapshot('reset', performance.now(), true);
        this.emitWirelessStubStatus('reset', true);
    }

    /**
     * Get the current clock divider for the PIO state machines.
     * Aligned with Velxio: uses the first enabled state machine's divider or defaults to 64.
     */
    private getPIOClockDiv(): number {
        if (!this.cpu) return 64;
        const pio = (this.cpu as any).pio;
        for (const p of pio) {
            if (p.stopped) continue;
            for (const m of p.machines) {
                if (m.enabled) {
                    return Math.max(1, m.clockDivInt || 1);
                }
            }
        }
        return 64;
    }

    stop() {
        this.running = false;
        this.clearPendingUartLedTimers();
        this.gdbStatus = 'closed';
        this.emitGdbStatus('stopped', 'Runner stopped');
        if (this.gdbWs) {
            try { this.gdbWs.close(); } catch {}
            this.gdbWs = null;
        }
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
    private componentSyncMeta = new Map<string, { lastSentAt: number; lastWeight: number }>();

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
        const now = performance.now();
        this.instances.forEach((inst, id) => {
            if (inst.stateChanged) {
                const syncState = inst.getSyncState();
                if (!this.shouldEmitComponentState(id, syncState, now)) return;
                components.push({ id, state: syncState });
                inst.stateChanged = false;
            }
        });
        if (components.length > 0) {
            this.onStateUpdate({ type: 'state', boardId: this.boardId, components, pins: this.pinStates });
        }
    }

    private shouldEmitComponentState(componentId: string, state: any, nowMs: number): boolean {
        const policy = getComponentStateSyncPolicy(state);
        const prev = this.componentSyncMeta.get(componentId);
        if (policy.minIntervalMs > 0 && prev && (nowMs - prev.lastSentAt) < policy.minIntervalMs) {
            return false;
        }
        this.componentSyncMeta.set(componentId, { lastSentAt: nowMs, lastWeight: policy.weight });
        return true;
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
        this.componentSyncMeta.clear();
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
