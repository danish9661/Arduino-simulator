import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';

const REG_WHO_AM_I = 0x00;
const REG_STATUS = 0x01;
const REG_FIFO = 0x3f;

export class SpiRadioLogic extends BaseComponent {
  private regs: Uint8Array;
  private txFifo: number[];
  private rxFifo: number[];

  private expectingAddr: boolean;
  private readMode: boolean;
  private regPtr: number;

  constructor(id: string, manifest: any) {
    super(id, manifest);

    const whoAmI = Number(manifest?.attrs?.whoAmI?.default ?? 0x42) & 0xff;

    this.regs = new Uint8Array(64);
    this.regs[REG_WHO_AM_I] = whoAmI;
    this.regs[REG_STATUS] = 0x00;

    this.txFifo = [];
    this.rxFifo = [];

    this.expectingAddr = true;
    this.readMode = false;
    this.regPtr = REG_WHO_AM_I;

    this.state = {
      selected: false,
      lastReg: REG_WHO_AM_I,
      lastByte: 0,
      irq0: false,
      irq2: false,
      txDepth: 0,
      rxDepth: 0,
    };
  }

  onPinStateChange(pinId: string, isHigh: boolean): void {
    if (pinId === 'CSN') {
      if (!isHigh) {
        // CS asserted low: begin new transaction
        this.expectingAddr = true;
        this.readMode = false;
        this.setState({ selected: true });
      } else {
        // CS deasserted high: end transaction framing
        this.expectingAddr = true;
        this.setState({ selected: false });
      }
    }
  }

  onSPIByte(data: number): number {
    const byte = data & 0xff;

    if (this.expectingAddr) {
      this.expectingAddr = false;
      this.readMode = (byte & 0x80) !== 0;
      this.regPtr = byte & 0x3f;
      this.setState({ lastReg: this.regPtr, lastByte: byte });
      return this.readMode ? this.readRegister(this.regPtr) : this.regs[REG_STATUS];
    }

    if (this.readMode) {
      const out = this.readRegister(this.regPtr);
      this.regPtr = (this.regPtr + 1) & 0x3f;
      this.setState({ lastReg: this.regPtr, lastByte: out, rxDepth: this.rxFifo.length });
      return out;
    }

    this.writeRegister(this.regPtr, byte);
    this.regPtr = (this.regPtr + 1) & 0x3f;
    this.setState({ lastReg: this.regPtr, lastByte: byte, txDepth: this.txFifo.length });
    return this.regs[REG_STATUS];
  }

  private readRegister(addr: number): number {
    const reg = addr & 0x3f;
    if (reg === REG_FIFO) {
      const val = this.rxFifo.length ? this.rxFifo.shift()! : 0x00;
      this.updateIrqPins();
      return val & 0xff;
    }
    return this.regs[reg] & 0xff;
  }

  private writeRegister(addr: number, value: number): void {
    const reg = addr & 0x3f;
    if (reg === REG_FIFO) {
      this.txFifo.push(value & 0xff);
      // Mock loopback behavior for driver bring-up: written TX bytes become RX bytes.
      this.rxFifo.push(value & 0xff);
      this.regs[REG_STATUS] = this.rxFifo.length > 0 ? 0x01 : 0x00;

      const irqOnWrite = this.state?.irqOnWrite ?? true;
      if (irqOnWrite) {
        this.setPinVoltage('GDO0', 5.0);
        this.setPinVoltage('GDO2', 5.0);
      }
      this.updateIrqPins();
      return;
    }

    this.regs[reg] = value & 0xff;
  }

  private updateIrqPins(): void {
    const pending = this.rxFifo.length > 0;
    if (!pending) {
      this.setPinVoltage('GDO0', 0.0);
      this.setPinVoltage('GDO2', 0.0);
    }
    this.setState({ irq0: this.getPinVoltage('GDO0') > 0.5, irq2: this.getPinVoltage('GDO2') > 0.5 });
  }

  onEvent(event: any): void {
    if (event?.type === 'CLEAR_IRQ') {
      this.setPinVoltage('GDO0', 0.0);
      this.setPinVoltage('GDO2', 0.0);
      this.setState({ irq0: false, irq2: false });
    }
  }

  getSyncState() {
    return {
      ...this.state,
      txDepth: this.txFifo.length,
      rxDepth: this.rxFifo.length,
      selected: this.getPinVoltage('CSN') < 0.5,
    };
  }
}
