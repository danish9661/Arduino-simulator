/**
 * micropython-runtime.ts
 *
 * A lightweight JS-native MicroPython interpreter for the RP2040 simulator.
 *
 * Instead of booting a full MicroPython UF2 (which requires USB CDC REPL over
 * emulated hardware), this module parses a small useful subset of MicroPython
 * and drives GPIO changes directly – exactly the way rp2040js listener callbacks
 * would fire when running real firmware.
 *
 * Supported subset:
 *  - from machine import Pin
 *  - from time import sleep, sleep_ms, sleep_us
 *  - import time
 *  - led = Pin(<number|'LED'>, Pin.OUT [, value=0|1])
 *  - led.value(0|1)  /  led.on()  /  led.off()  /  led.toggle()
 *  - time.sleep() / time.sleep_ms() / time.sleep_us()
 *  - while True: ...
 *  - if / else (basic)
 *  - print(...)
 */

export type GpioCallback = (gpioNum: number, isHigh: boolean) => void;
export type SerialCallback = (text: string) => void;

interface PinObject {
    gpioNum: number;
    _value: number;
    OUT: number;
    IN: number;
    value(v?: number): number | void;
    on(): void;
    off(): void;
    toggle(): void;
}

interface RuntimeEnv {
    onGpioChange: GpioCallback;
    onSerial?: SerialCallback;
    stopped: boolean;
}

// Map 'LED' -> GPIO 25 (onboard LED)
function resolvePinNum(pinArg: string | number): number {
    if (pinArg === 'LED' || pinArg === "'LED'" || pinArg === '"LED"') return 25;
    const n = typeof pinArg === 'number' ? pinArg : parseInt(String(pinArg), 10);
    return isNaN(n) ? 0 : n;
}

function makePinObject(gpioNum: number, env: RuntimeEnv): PinObject {
    const pin: PinObject = {
        gpioNum,
        _value: 0,
        OUT: 1,
        IN: 0,
        value(v?: number) {
            if (v === undefined) return pin._value;
            pin._value = v ? 1 : 0;
            env.onGpioChange(gpioNum, pin._value === 1);
        },
        on() { pin.value(1); },
        off() { pin.value(0); },
        toggle() { pin.value(pin._value ? 0 : 1); },
    };
    return pin;
}

/** Tokenise a single complete line into parts, preserving strings. */
function tokeniseLine(line: string): string[] {
    const parts: string[] = [];
    let buf = '';
    let inStr = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
            buf += ch;
            if (ch === inStr) { inStr = ''; parts.push(buf); buf = ''; }
        } else if (ch === '"' || ch === "'") {
            if (buf.trim()) { parts.push(buf.trim()); buf = ''; }
            buf = ch; inStr = ch;
        } else if (ch === '(' || ch === ')' || ch === ',' || ch === '=') {
            if (buf.trim()) parts.push(buf.trim());
            parts.push(ch);
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
}

/** Evaluate a basic expression in the scope dict. Returns a JS value. */
function evalExpr(expr: string, scope: Record<string, any>): any {
    const trimmed = expr.trim();
    // Simple binary math used in common teaching scripts (e.g. i % 2)
    const binaryMath = trimmed.match(/^(.+)\s*([%+\-*/])\s*(.+)$/);
    if (binaryMath) {
        const left = Number(evalExpr(binaryMath[1], scope));
        const right = Number(evalExpr(binaryMath[3], scope));
        if (Number.isFinite(left) && Number.isFinite(right)) {
            const op = binaryMath[2];
            if (op === '%' && right !== 0) return left % right;
            if (op === '+') return left + right;
            if (op === '-') return left - right;
            if (op === '*') return left * right;
            if (op === '/' && right !== 0) return left / right;
        }
    }
    // Numeric literal
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // String literal
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1);
    }
    // Boolean
    if (trimmed === 'True') return true;
    if (trimmed === 'False') return false;
    if (trimmed === 'None') return null;
    // Attribute like Pin.OUT
    if (trimmed.includes('.')) {
        const [obj, attr] = trimmed.split('.');
        const o = scope[obj.trim()];
        return o !== undefined ? o[attr.trim()] : undefined;
    }
    // Variable lookup
    return scope[trimmed];
}

/** Parse call arguments from string "(arg1, arg2, ...)" → array of raw strings */
function parseArgs(argsStr: string): string[] {
    const inner = argsStr.replace(/^\s*\(\s*/, '').replace(/\s*\)\s*$/, '');
    const parts: string[] = [];
    let depth = 0, buf = '', inStr = '';
    for (const ch of inner) {
        if (inStr) { buf += ch; if (ch === inStr) inStr = ''; }
        else if (ch === '"' || ch === "'") { buf += ch; inStr = ch; }
        else if (ch === '(') { depth++; buf += ch; }
        else if (ch === ')') { depth--; buf += ch; }
        else if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; }
        else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
}

// ─── Async sleep helpers ──────────────────────────────────────────────────────

function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Statement execution ─────────────────────────────────────────────────────

/**
 * Execute one statement (line or block). Returns false if stopped.
 */
async function execStatement(
    stmt: string,
    scope: Record<string, any>,
    env: RuntimeEnv
): Promise<boolean> {
    if (env.stopped) return false;
    const s = stmt.trim();
    if (!s || s.startsWith('#')) return true;

    // --- import statements (no-op for supported modules) ---
    if (/^(from\s+\S+\s+import|import\s+)/.test(s)) return true;

    // --- Pin construction: led = Pin(20, Pin.OUT) or Pin('LED', Pin.OUT) ---
    const pinAssignMatch = s.match(/^(\w+)\s*=\s*Pin\s*\((.+)\)$/);
    if (pinAssignMatch) {
        const varName = pinAssignMatch[1];
        const argStr = pinAssignMatch[2];
        const args = parseArgs(`(${argStr})`);
        const pinNumRaw = args[0] ? evalExpr(args[0], scope) : 0;
        const gpioNum = resolvePinNum(pinNumRaw);
        scope[varName] = makePinObject(gpioNum, env);
        // If value keyword arg provided, set immediately
        const valueKwarg = argStr.match(/\bvalue\s*=\s*(\d+)/);
        if (valueKwarg) scope[varName].value(parseInt(valueKwarg[1], 10));
        return true;
    }

    // --- method calls: led.value(1), led.on(), led.off(), led.toggle() ---
    const methodMatch = s.match(/^(\w+)\.(value|on|off|toggle)\s*\(([^)]*)\)$/);
    if (methodMatch) {
        const obj = scope[methodMatch[1]];
        const method = methodMatch[2] as 'value' | 'on' | 'off' | 'toggle';
        if (obj && typeof obj[method] === 'function') {
            const argRaw = methodMatch[3].trim();
            if (method === 'value' && argRaw !== '') {
                const nextVal = evalExpr(argRaw, scope);
                obj.value(Number(nextVal) ? 1 : 0);
            } else {
                (obj[method] as Function)();
            }
        }
        return true;
    }

    // --- sleep_ms(n), sleep_us(n), sleep(n) ---
    const sleepMatch = s.match(/^(?:time\.)?(sleep(?:_ms|_us)?)\s*\(([^)]+)\)$/);
    if (sleepMatch) {
        const fn = sleepMatch[1];
        const argVal = evalExpr(sleepMatch[2], scope);
        const ms = fn === 'sleep_us' ? Number(argVal) / 1000
                :  fn === 'sleep'    ? Number(argVal) * 1000
                :                     Number(argVal);
        if (!env.stopped) await sleepMs(ms);
        return !env.stopped;
    }

    // --- print(...) ---
    const printMatch = s.match(/^print\s*\((.+)\)$/);
    if (printMatch) {
        if (env.onSerial) {
            const args = parseArgs(`(${printMatch[1]})`);
            const out = args.map((arg) => evalExpr(arg, scope)).map((v) => String(v ?? '')).join(' ');
            env.onSerial(out + '\n');
        }
        return true;
    }

    // --- variable assignment: x = <expr> ---
    const assignMatch = s.match(/^(\w+)\s*=\s*(.+)$/);
    if (assignMatch) {
        scope[assignMatch[1]] = evalExpr(assignMatch[2], scope);
        return true;
    }

    return true; // Unknown statement – skip silently
}

// ─── Block execution ──────────────────────────────────────────────────────────

interface Block {
    type: 'while_true' | 'if' | 'else' | 'other';
    condition?: string;
    body: string[];
}

function detectIndent(lines: string[]): number {
    for (const l of lines) {
        const m = l.match(/^(\s+)/);
        if (m && m[1].length > 0) return m[1].length;
    }
    return 4;
}

async function execBlock(
    lines: string[],
    scope: Record<string, any>,
    env: RuntimeEnv,
    depth = 0
): Promise<boolean> {
    const baseIndent = depth * detectIndent(lines);
    let i = 0;

    while (i < lines.length) {
        if (env.stopped) return false;
        const raw = lines[i];
        const stripped = raw.trimStart();
        if (!stripped || stripped.startsWith('#')) { i++; continue; }

        // Collect block body
        const blockBodyLines: string[] = [];
        const blockIndent = (raw.match(/^(\s*)/)?.[1].length ?? 0) + (detectIndent(lines) || 4);

        if (stripped.startsWith('while True:') || stripped.startsWith('while true:')) {
            i++;
            while (i < lines.length) {
                const bl = lines[i];
                const blStripped = bl.trimStart();
                if (!blStripped || blStripped.startsWith('#')) { i++; continue; }
                const blIndent = bl.match(/^(\s*)/)?.[1].length ?? 0;
                if (blIndent <= (raw.match(/^(\s*)/)?.[1].length ?? 0)) break;
                blockBodyLines.push(bl.slice(blockIndent > blIndent ? blIndent : blockIndent));
                i++;
            }
            // Infinite loop
            while (!env.stopped) {
                const ok = await execBlock(blockBodyLines, scope, env, 0);
                if (!ok) return false;
            }
            return false;
        }

        const forRangeMatch = stripped.match(/^for\s+(\w+)\s+in\s+range\(([^)]*)\):$/);
        if (forRangeMatch) {
            const loopVar = forRangeMatch[1];
            const rangeArgs = parseArgs(`(${forRangeMatch[2]})`).map((part) => Number(evalExpr(part, scope)));
            let start = 0;
            let end = 0;
            let step = 1;

            if (rangeArgs.length === 1) {
                end = Number.isFinite(rangeArgs[0]) ? rangeArgs[0] : 0;
            } else if (rangeArgs.length >= 2) {
                start = Number.isFinite(rangeArgs[0]) ? rangeArgs[0] : 0;
                end = Number.isFinite(rangeArgs[1]) ? rangeArgs[1] : start;
                if (rangeArgs.length >= 3 && Number.isFinite(rangeArgs[2]) && rangeArgs[2] !== 0) {
                    step = rangeArgs[2];
                }
            }

            i++;
            while (i < lines.length) {
                const bl = lines[i];
                const blStripped = bl.trimStart();
                if (!blStripped || blStripped.startsWith('#')) { i++; continue; }
                const blIndent = bl.match(/^(\s*)/)?.[1].length ?? 0;
                if (blIndent <= (raw.match(/^(\s*)/)?.[1].length ?? 0)) break;
                blockBodyLines.push(bl.slice(blockIndent > blIndent ? blIndent : blockIndent));
                i++;
            }

            if (step > 0) {
                for (let v = start; v < end && !env.stopped; v += step) {
                    scope[loopVar] = v;
                    const ok = await execBlock(blockBodyLines, scope, env, 0);
                    if (!ok) return false;
                }
            } else {
                for (let v = start; v > end && !env.stopped; v += step) {
                    scope[loopVar] = v;
                    const ok = await execBlock(blockBodyLines, scope, env, 0);
                    if (!ok) return false;
                }
            }
            continue;
        }

        if (stripped.startsWith('if ') && stripped.endsWith(':')) {
            const condStr = stripped.slice(3, -1).trim();
            i++;
            while (i < lines.length) {
                const bl = lines[i];
                const blStripped = bl.trimStart();
                if (!blStripped || blStripped.startsWith('#')) { i++; continue; }
                const blIndent = bl.match(/^(\s*)/)?.[1].length ?? 0;
                if (blIndent <= (raw.match(/^(\s*)/)?.[1].length ?? 0)) break;
                blockBodyLines.push(bl.slice(blockIndent > blIndent ? blIndent : blockIndent));
                i++;
            }
            const cond = evalExpr(condStr, scope);
            if (cond) {
                const ok = await execBlock(blockBodyLines, scope, env, 0);
                if (!ok) return false;
            }
            continue;
        }

        // Plain statement
        const ok = await execStatement(stripped, scope, env);
        if (!ok) return false;
        i++;
    }

    return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface MicroPythonRunnerOptions {
    onGpioChange: GpioCallback;
    onSerial?: SerialCallback;
    onError?: (msg: string) => void;
}

export class MicroPythonRunner {
    private env: RuntimeEnv;
    private stopRequested = false;

    constructor(private script: string, private opts: MicroPythonRunnerOptions) {
        this.env = {
            onGpioChange: opts.onGpioChange,
            onSerial: opts.onSerial,
            stopped: false,
        };
    }

    async run(): Promise<void> {
        const scope: Record<string, any> = {
            Pin: { OUT: 1, IN: 0 },
            time: {
                sleep: (s: number) => sleepMs(s * 1000),
                sleep_ms: (ms: number) => sleepMs(ms),
                sleep_us: (us: number) => sleepMs(us / 1000),
            },
            True: true, False: false, None: null,
        };

        const lines = this.script.replace(/\r\n/g, '\n').split('\n');

        try {
            await execBlock(lines, scope, this.env, 0);
        } catch (err: any) {
            if (this.opts.onError) {
                this.opts.onError(`MicroPython runtime error: ${err?.message || err}`);
            }
        }
    }

    stop() {
        this.env.stopped = true;
        this.stopRequested = true;
    }
}
