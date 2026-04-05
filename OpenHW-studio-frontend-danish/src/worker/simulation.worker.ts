import { BoardRunner, createRunnerForBoard, LOGIC_REGISTRY, COMPONENT_PINS } from './execute';
import { BaseComponent } from '@openhw/emulator/src/components/BaseComponent.ts';
import {
    isProgrammableBoardType,
    resolveUartRoute,
    areBoardsSoftSerialConnected,
} from './protocol-routing.js';

let runner: BoardRunner | null = null;
let boardRunners: Map<string, BoardRunner> = new Map();
let boardTypes: Map<string, string> = new Map();
let mode: 'single' | 'multi' = 'single';
let pinToNet: Map<string, number> = new Map();

function buildMicroPythonPastePayload(scriptSource: string): string {
    const normalized = String(scriptSource || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\u0004/g, ''))
        .join('\r\n');
    // Ctrl-C, Ctrl-C, Ctrl-E (paste mode), script, Ctrl-D (execute)
    return `\u0003\u0003\u0005${normalized}\r\n\u0004`;
}

function buildMicroPythonRawPayload(scriptSource: string): string {
    const normalized = String(scriptSource || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\u0004/g, ''))
        .join('\n');
    // Ctrl-A (raw REPL), script, Ctrl-D (execute).
    // Do not prepend Ctrl-C here: probe kicks already interrupt to prompt,
    // and extra Ctrl-C bytes can leak into execution as KeyboardInterrupt.
    return `\u0001${normalized}\n\u0004`;
}

function buildMicroPythonReplProbe(boardId: string): string {
    void boardId;
    // Non-interrupting probe: nudge REPL to emit a prompt without injecting
    // Ctrl-C, which can otherwise break user scripts with KeyboardInterrupt.
    return '\r\n';
}

/**
 * Waits until the MicroPython REPL '>>>' prompt appears on the board UART,
 * then sends the script once via raw-REPL mode. Falls back after `timeoutMs` ms.
 *
 * Works by monkey-patching the runner's onStateUpdate to sniff serial bytes
 * from the cpu.uart[0] callback, without interfering with the existing flow.
 */
function scheduleMicroPythonInject(
    target: BoardRunner,
    boardId: string,
    pyScript: string,
    baudOverride: number,
    timeoutMs = 12000
): void {
    const rawPayload = buildMicroPythonRawPayload(pyScript);
    const replProbePayload = buildMicroPythonReplProbe(boardId);
    const startedAt = Date.now();
    let uartBuf = '';
    let finalized = false;
    let probeTimer: any = null;
    let timeoutGuard: any = null;
    let injectedOnce = false;
    let restoreUart0OnByte: (() => void) | null = null;

    const clearTimers = () => {
        if (probeTimer) {
            clearInterval(probeTimer);
            probeTimer = null;
        }
        if (timeoutGuard) {
            clearTimeout(timeoutGuard);
            timeoutGuard = null;
        }
    };

    const finalize = () => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        if (restoreUart0OnByte) {
            restoreUart0OnByte();
            restoreUart0OnByte = null;
        }
    };

    const sendProbe = () => {
        if (finalized) return;
        if (!target) return;

        // Keep REPL responsive and request a prompt.
        target.setSerialBaudRate(baudOverride);
        target.serialRx(replProbePayload);
    };

    const sendRawOnce = () => {
        if (finalized || injectedOnce) return;
        if (!target) return;

        injectedOnce = true;
        // Drop stale probe bytes so raw payload starts cleanly.
        const targetAny = target as any;
        if (Array.isArray(targetAny?.serialBuffer)) {
            targetAny.serialBuffer.length = 0;
        }
        target.setSerialBaudRate(baudOverride);
        target.serialRx(rawPayload);
        finalize();
    };

    const shouldForceInjectFromBootTraffic = () => {
        const targetAny = target as any;
        const waitedMs = Date.now() - startedAt;
        if (waitedMs < 2200) return false;

        const txBytes = Number(targetAny?.debugSerialTxBytes || 0);
        const activeUart = Number(targetAny?.activeUartIndex ?? -1);
        const usbReady = !!targetAny?.usbCdcReady;

        // USB-first MicroPython builds can expose prompt/output on USB CDC while
        // uart[0] prompt sniffing stays quiet. Use tx activity as readiness signal.
        if (txBytes >= 64 && (activeUart === 2 || usbReady)) return true;
        if (txBytes >= 192) return true;
        return false;
    };

    // Sniff UART output by wrapping the cpu uart onByte callback.
    // rp2040js exposes cpu.uart[0].onByte – we chain onto it.
    const patchUart = () => {
        const cpu = (target as any).cpu;
        if (!cpu?.uart?.[0]) return false;
        const prev = cpu.uart[0].onByte;
        const patched = (value: number) => {
            if (prev) prev(value);
            if (finalized) return;

            uartBuf += String.fromCharCode(value);
            if (uartBuf.length > 32) uartBuf = uartBuf.slice(-32);

            if (uartBuf.includes('>>>')) {
                sendRawOnce();
            }
        };
        cpu.uart[0].onByte = patched;
        restoreUart0OnByte = () => {
            if ((cpu as any)?.uart?.[0]?.onByte === patched) {
                cpu.uart[0].onByte = prev;
            }
        };
        return true;
    };

    // The cpu may not be initialised exactly when we schedule, retry briefly.
    let patchAttempts = 0;
    const tryPatch = () => {
        if (finalized) return;
        if (patchUart()) return; // success
        if (++patchAttempts < 10) setTimeout(tryPatch, 50);
    };
    tryPatch();

    // Initial kick after boot; only probes here, no script payload yet.
    setTimeout(() => {
        if (finalized) return;
        sendProbe();
    }, 1400);

    // Repeat probe while waiting for prompt; inject once when detected.
    probeTimer = setInterval(() => {
        if (finalized) {
            clearTimers();
            return;
        }
        if (shouldForceInjectFromBootTraffic()) {
            sendRawOnce();
            return;
        }
        sendProbe();
    }, 2800);

    // Final guard: if prompt sniff fails, inject exactly once anyway.
    timeoutGuard = setTimeout(() => {
        if (!finalized) {
            sendRawOnce();
        }
    }, timeoutMs);
}

function stopAllRunners() {
    if (runner) {
        runner.stop();
        runner = null;
    }
    boardRunners.forEach((r) => r.stop());
    boardRunners.clear();
    boardTypes.clear();
    pinToNet.clear();
}

function endpointAliases(endpoint: string): string[] {
    const [compId, pinId] = endpoint.split(':');
    if (!compId || !pinId) return [endpoint];

    const aliases = new Set<string>([endpoint]);
    if (/^\d+$/.test(pinId)) aliases.add(`${compId}:D${pinId}`);
    if (/^D\d+$/i.test(pinId)) aliases.add(`${compId}:${pinId.substring(1)}`);
    return Array.from(aliases);
}

function buildNetIndex(wires: any[]) {
    const adj = new Map<string, string[]>();

    for (const wire of wires || []) {
        if (!adj.has(wire.from)) adj.set(wire.from, []);
        if (!adj.has(wire.to)) adj.set(wire.to, []);
        adj.get(wire.from)!.push(wire.to);
        adj.get(wire.to)!.push(wire.from);
    }

    const visited = new Set<string>();
    pinToNet.clear();
    let currentNet = 0;

    for (const startNode of adj.keys()) {
        if (visited.has(startNode)) continue;
        const queue = [startNode];
        visited.add(startNode);
        while (queue.length > 0) {
            const node = queue.shift()!;
            pinToNet.set(node, currentNet);
            endpointAliases(node).forEach((alias) => pinToNet.set(alias, currentNet));

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

function areConnected(pinA: string, pinB: string): boolean {
    const netA = pinToNet.get(pinA);
    const netB = pinToNet.get(pinB);
    return netA !== undefined && netA === netB;
}

function resolveRp2040ExecutableRanges(boardComp: any, boardExecutableRangesMap: any): any[] | undefined {
    const boardId = String(boardComp?.id || '').trim();
    const fromMap = boardId ? boardExecutableRangesMap?.[boardId] : undefined;
    const fromAttrs = boardComp?.attrs?.rp2040ExecutableRanges;
    const candidate = fromMap ?? fromAttrs;
    return Array.isArray(candidate) ? candidate : undefined;
}

function postRunnerState(stateObj: any, boardId: string) {
    if (mode === 'single') {
        postMessage(stateObj);
        return;
    }

    if (stateObj.type !== 'state') {
        postMessage({ ...stateObj, boardId });
        return;
    }

    const msg: any = { type: 'state', boardId };

    if (stateObj.pins) msg.pins = stateObj.pins;

    if (stateObj.analog) msg.analog = stateObj.analog;
    if (stateObj.components) msg.components = stateObj.components;
    postMessage(msg);
}

function isSoftSerialLabel(label: string): boolean {
    const key = String(label || '').trim().toLowerCase();
    return key === 'softserial' || key === 'soft-serial' || key === 'soft_uart' || key === 'soft-uart' || key === 'softuart';
}

function routeUartByte(sourceBoardId: string, value: number, sourceLabel = 'uart0') {
    const sourceRunner = boardRunners.get(sourceBoardId);
    const sourceType = boardTypes.get(sourceBoardId) || '';
    const sourceBaud = sourceRunner?.getSerialBaudRate?.() ?? 9600;
    const fromSoftSerial = isSoftSerialLabel(sourceLabel);

    for (const [targetBoardId, targetRunner] of boardRunners.entries()) {
        if (targetBoardId === sourceBoardId) continue;

        const targetType = boardTypes.get(targetBoardId) || '';
        const uartRoute = fromSoftSerial
            ? { connected: false, targetSource: null }
            : resolveUartRoute(sourceBoardId, sourceType, targetBoardId, targetType, areConnected, sourceLabel);
        const softLinked = areBoardsSoftSerialConnected(sourceBoardId, sourceType, targetBoardId, targetType, areConnected);

        if (uartRoute.connected || softLinked) {
            targetRunner.setSerialBaudRate(sourceBaud);
            if (uartRoute.connected && typeof (targetRunner as any).serialRxByteFromSource === 'function') {
                (targetRunner as any).serialRxByteFromSource(value, uartRoute.targetSource || 'uart0');
            } else if (softLinked && typeof (targetRunner as any).softSerialRxByte === 'function') {
                (targetRunner as any).softSerialRxByte(value);
            } else {
                targetRunner.serialRxByte(value);
            }
        }
    }
}

self.onmessage = async (e) => {
    const data = e.data;

    if (data.type === 'START') {
        const { hex, components, wires, customLogics, boardHexMap, boardPythonMap, baudRate, boardBaudMap, boardExecutableRangesMap, debugRp2040 } = data;
        const rp2040DebugEnabled = !!debugRp2040;

        stopAllRunners();

        // --- INJECT TEMPORARY SANDBOX LOGIC ---
        if (customLogics && Array.isArray(customLogics)) {
            customLogics.forEach((cl: any) => {
                try {
                    const exportsObj: any = {};
                    const requireFn = (mod: string) => {
                        if (mod.includes('BaseComponent')) return { BaseComponent };
                        return {};
                    };
                    const evalFn = new Function('exports', 'require', cl.code);
                    evalFn(exportsObj, requireFn);

                    const LogicClass = exportsObj[Object.keys(exportsObj)[0]] || exportsObj.default;
                    if (LogicClass) {
                        LOGIC_REGISTRY[cl.type] = LogicClass;
                        COMPONENT_PINS[cl.type] = cl.pins;
                        console.log(`[Worker] Sandbox injected component logic for: ${cl.type}`);
                    }
                } catch (e) {
                    console.error(`[Worker] Failed to inject sandbox logic for ${cl.type}:`, e);
                }
            });
        }

        const programmableBoards = (components || []).filter((c: any) => isProgrammableBoardType(c.type));
        const sharedPeripheralComponents = (components || []).filter((c: any) => !isProgrammableBoardType(c.type));

        if (programmableBoards.length <= 1) {
            mode = 'single';
            const singleBoardType = String(programmableBoards[0]?.type || 'wokwi-arduino-uno');
            const singleBoardId = programmableBoards[0]?.id;
            const pyScript = singleBoardId ? (boardPythonMap?.[singleBoardId] || '') : '';
            const singleBoardIsRp2040 = /(rp2040|pico)/i.test(singleBoardType);
            const singleBoardExecutableRanges = resolveRp2040ExecutableRanges(programmableBoards[0], boardExecutableRangesMap);

            runner = createRunnerForBoard(
                singleBoardType,
                hex,
                components,
                wires,
                (stateObj) => postMessage(stateObj),
                {
                    boardId: singleBoardId,
                    serialBaudRate: Number(boardBaudMap?.[singleBoardId] ?? baudRate ?? 9600),
                    debugEnabled: singleBoardIsRp2040 && rp2040DebugEnabled,
                    debugIntervalMs: singleBoardIsRp2040 && rp2040DebugEnabled ? 1200 : 0,
                    // Pass pyScript metadata so the worker can inject over UART0 after boot.
                    pyScript: typeof pyScript === 'string' ? pyScript : '',
                    onByteTransmit: ({ boardId, value, char, source }) => {
                        postMessage({ type: 'serial', data: char, boardId, value, source });
                    },
                    rp2040ExecutableRanges: singleBoardIsRp2040 ? singleBoardExecutableRanges : undefined,
                }
            );

            if (singleBoardId) {
                boardTypes.set(singleBoardId, singleBoardType);
                if (pyScript?.trim() && (runner as any)?.cpu?.uart?.[0]) {
                    scheduleMicroPythonInject(
                        runner!,
                        singleBoardId,
                        pyScript,
                        Number(boardBaudMap?.[singleBoardId] ?? 115200)
                    );
                }
            }
            return;
        }

        mode = 'multi';
        buildNetIndex(wires || []);

        programmableBoards.forEach((boardComp: any) => {
            const fwHex = boardHexMap?.[boardComp.id] || boardComp?.attrs?.firmwareHex || boardComp?.attrs?.hex;
            const executableRanges = resolveRp2040ExecutableRanges(boardComp, boardExecutableRangesMap);
            if (typeof fwHex !== 'string' || !fwHex.trim()) {
                console.warn(`[Worker] Skipping board ${boardComp.id}: no board-specific firmware available.`);
                return;
            }
            const runnerComponents = [boardComp, ...sharedPeripheralComponents];
            const pyScript = boardPythonMap?.[boardComp.id] || '';

            const boardRunner = createRunnerForBoard(
                String(boardComp.type || ''),
                typeof fwHex === 'string' ? fwHex : '',
                runnerComponents,
                wires,
                (stateObj) => postRunnerState(stateObj, boardComp.id),
                {
                    boardId: boardComp.id,
                    serialBaudRate: Number(boardBaudMap?.[boardComp.id] ?? baudRate ?? 9600),
                    debugEnabled: /(rp2040|pico)/i.test(String(boardComp.type || '')) && rp2040DebugEnabled,
                    debugIntervalMs: /(rp2040|pico)/i.test(String(boardComp.type || '')) && rp2040DebugEnabled ? 1200 : 0,
                    pyScript: typeof pyScript === 'string' ? pyScript : '',
                    onByteTransmit: ({ boardId, value, char, source }) => {
                        postMessage({ type: 'serial', data: char, boardId, value, source });
                        routeUartByte(boardId, value, source || 'uart0');
                    },
                    rp2040ExecutableRanges: /(rp2040|pico)/i.test(String(boardComp.type || '')) ? executableRanges : undefined,
                }
            );

            boardRunners.set(boardComp.id, boardRunner);
            boardTypes.set(boardComp.id, String(boardComp.type || ''));
        });

        programmableBoards.forEach((boardComp: any) => {
            const pyScript = boardPythonMap?.[boardComp.id];
            if (typeof pyScript !== 'string' || !pyScript.trim()) return;
            const target = boardRunners.get(boardComp.id);
            if (!target) return;
            if ((target as any)?.cpu?.uart?.[0]) {
                scheduleMicroPythonInject(
                    target,
                    boardComp.id,
                    pyScript,
                    Number(boardBaudMap?.[boardComp.id] ?? 115200)
                );
            }
        });

    } else if (data.type === 'STOP') {
        stopAllRunners();
    } else if (data.type === 'INTERACT') {
        console.log(`[Worker] Received INTERACT for ${data.compId}: ${data.event}`);

        if (mode === 'single' && runner) {
            const inst = runner.instances.get(data.compId);
            if (inst && typeof inst.onEvent === 'function') {
                inst.onEvent(data.event);
            }
        } else {
            let delivered = false;
            for (const boardRunner of boardRunners.values()) {
                const inst = boardRunner.instances.get(data.compId);
                if (inst && typeof inst.onEvent === 'function') {
                    inst.onEvent(data.event);
                    delivered = true;
                }
            }
            if (!delivered) {
                console.warn(`[Worker] INTERACT target not found in any runner: ${data.compId}`);
            }
        }
    } else if (data.type === 'SERIAL_SET_BAUD') {
        const parsedBaud = Number(data.baudRate);
        if (!Number.isFinite(parsedBaud)) {
            return;
        }

        if (mode === 'single' && runner) {
            runner.setSerialBaudRate(parsedBaud);
        } else if (data.targetBoardId) {
            const target = boardRunners.get(data.targetBoardId);
            if (!target) return;
            target.setSerialBaudRate(parsedBaud);
        } else {
            boardRunners.forEach((boardRunner) => {
                boardRunner.setSerialBaudRate(parsedBaud);
            });
        }
    } else if (data.type === 'SERIAL_INPUT') {
        if (mode === 'single' && runner) {
            if (data.baudRate) runner.setSerialBaudRate(Number(data.baudRate));
            runner.serialRx(data.data);
        } else {
            if (data.targetBoardId) {
                if (!boardRunners.has(data.targetBoardId)) {
                    return;
                }
                const target = boardRunners.get(data.targetBoardId)!;
                if (data.baudRate) target.setSerialBaudRate(Number(data.baudRate));
                target.serialRx(data.data);
            } else {
                boardRunners.forEach((boardRunner) => {
                    if (data.baudRate) boardRunner.setSerialBaudRate(Number(data.baudRate));
                    boardRunner.serialRx(data.data);
                });
            }
        }
    } else if (data.type === 'RESET') {
        if (mode === 'single' && runner) {
            if (typeof runner.reset === 'function') runner.reset();
            else if (runner.cpu) runner.cpu.reset();
        } else {
            boardRunners.forEach((boardRunner) => {
                if (typeof boardRunner.reset === 'function') boardRunner.reset();
                else if (boardRunner.cpu) boardRunner.cpu.reset();
            });
        }
    }
};
