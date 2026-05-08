// Polyfill for libraries that expect a browser environment (like React Refresh injected by Vite)
if (typeof window === 'undefined') {
    (self as any).window = self;
    (self as any).document = {
        createElement: () => ({ style: {} }),
        getElementsByTagName: () => [],
        createTextNode: () => ({}),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

// React Refresh Mocks (Vite HMR)
(self as any).$RefreshReg$ = () => {};
(self as any).$RefreshSig$ = () => () => (type: any) => type;

console.log("[HEARTBEAT] Worker [v3.8]: Environment Polyfilled.");
self.postMessage({ type: 'LOG', msg: "Worker is ALIVE (Dynamic Loader Mode)." });

function timeStamp() {
    return new Date().toLocaleTimeString();
}
const jsonLogs: any[] = [];

function sendJsonLog(message: string, level = 'info', source = 'grading-engine') {
    const payload = { time: timeStamp(), source, level, message };
    jsonLogs.push(payload);
    self.postMessage({ type: 'LOG_JSON', payload });
}

let wasmExports: any = null;
let emulatorExports: any = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

async function initEngine() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            if (isInitialized) return;
            console.log("[HEARTBEAT] Worker: initEngine() started...");
            sendJsonLog('Initializing Grading Engine (Rust/WASM)...', 'info');

            // 1. Dynamic WASM Glue
            wasmExports = await import('../wasm/grading/openhw_studio_grading_engine.js');
            const wasmUrlMod = await import('../wasm/grading/openhw_studio_grading_engine_bg.wasm?url');
            const wasmUrl = String((wasmUrlMod as any).default || wasmUrlMod);

            await wasmExports.default(wasmUrl);
            console.log("[HEARTBEAT] Worker: WASM initialized.");
            console.log("[HEARTBEAT] Worker: WASM Exports available:", Object.keys(wasmExports || {}));

            if (wasmExports && wasmExports.init_panic_hook) wasmExports.init_panic_hook();

            // 2. Dynamic Emulator Logic
            postMessage({ type: 'LOG', msg: "Loading Emulator Validator logic..." });
            emulatorExports = await import("@openhw/emulator");
            console.log("[HEARTBEAT] Worker: Emulator logic loaded. Keys:", Object.keys(emulatorExports || {}));

            // Basic validation of emulator exports
            if (!emulatorExports || !emulatorExports.FullCircuitValidator || !emulatorExports.analyzeCodeHardwareSync) {
                throw new Error('Emulator exports missing required symbols (FullCircuitValidator, analyzeCodeHardwareSync)');
            }

            isInitialized = true;
            sendJsonLog('Grading Engine (WASM + Logic) Ready.', 'info');
        } catch (err: any) {
            console.error("[HEARTBEAT] Worker: DYNAMIC INIT FAILED:", err);
            postMessage({ type: 'LOG', msg: `CRITICAL: Init Failed: ${err?.message || String(err)}`, logType: 'error' });
            initPromise = null; // allow retry on next call
            throw err;
        }
    })();
    return initPromise;
}

// Global error handler
self.onerror = (msg, url, lineNo, columnNo, error) => {
    console.error(`Grading Worker Error: ${msg} at ${lineNo}:${columnNo}`, error);
    (self as any).postMessage({ type: 'LOG', msg: `WORKER CRASH: ${msg}`, logType: 'error' });
    return false;
};

interface GradingOptions {
    exact_match: boolean;
    check_breadboard: boolean;
    check_overlap: boolean;
    ignore_pin_changes: boolean;
}

interface TeacherData {
    project: string;
    telemetry: string;
}

interface GradingMessage {
    type: 'GENERATE_KEY' | 'GRADE';
    teacher: TeacherData | Uint8Array;
    student?: ArrayBuffer;
    studentTelemetry?: string;
    options: GradingOptions;
    simulationSpeed?: number;
}

import { getBoardCompileFiles, extractProjectMetaFromPng } from '../utils/projectCompilerUtils';

function mapBoardToFqbn(board: string): string {
    const s = String(board || '').toLowerCase();
    if (s.includes('uno')) return 'arduino:avr:uno';
    if (s.includes('mega')) return 'arduino:avr:mega';
    if (s.includes('nano')) return 'arduino:avr:nano';
    if (s.includes('esp32')) return 'esp32:esp32:esp32';
    if (s.includes('stm32')) return 'STMicroelectronics:stm32:GenF1';
    if (s.includes('rp2040') || s.includes('pico')) return 'rp2040:rp2040:rpipico';
    return 'arduino:avr:uno';
}

async function compileSourceCode(payload: any, board: string): Promise<string> {
    const COMPILER_URL = 'http://localhost:5001/api/compile';
    const fqbn = mapBoardToFqbn(board);
    
    console.log(`[v2.8] Requesting compilation for ${fqbn} (Sketch: ${payload.sketchName})...`);
    
    try {
        const response = await fetch(COMPILER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                ...payload,
                board: fqbn 
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            const errorMsg = data.error || data.message || 'Unknown compiler error';
            const hint = data.diagnostics?.hint ? ` Hint: ${data.diagnostics.hint}` : '';
            const details = data.details ? `\nDetails: ${data.details}` : '';
            throw new Error(`${errorMsg}${hint}${details} (Status: ${response.status})`);
        }

        if (data && data.hex) return data.hex;
        throw new Error('Backend returned success but no HEX binary was found in response.');
    } catch (err: any) {
        throw new Error(`[Network/API Error] ${err?.message || String(err)}`);
    }
}

async function captureBehavior(meta: any, durationMs: number, label: string, simulationSpeed = 1): Promise<any> {
    const TELEMETRY_CUTOFF_MS = 7900;
    const telemetry = {
        events: [] as any[],
        serial: "",
        duration_ms: durationMs,
        error: null as string | null,
        crashed: false,
        rich_metrics: null as string | null
    };

    let lastComponentStates: Record<string, any> = {};
    let lastPinStates: Record<string, boolean> = {};
    let runner: any = null;
    const startTime = Date.now();
    const normalizedSpeed = Number.isFinite(simulationSpeed) && simulationSpeed > 0 ? simulationSpeed : 1;
    const effectiveCutoffMs = Math.min(durationMs, TELEMETRY_CUTOFF_MS);

    const pushTelemetryEvent = (event: any, nowMs: number): boolean => {
        if (!Number.isFinite(nowMs) || nowMs > effectiveCutoffMs) {
            return false;
        }
        telemetry.events.push(event);
        return true;
    };

    try {
        const { createRunnerForBoard } = await import('./execute');
        const boardComp = (meta.components || []).find((c: any) => /(arduino|esp32|stm32|rp2040|pico)/i.test(String(c.type || '')));
        
        const boardCompId = boardComp?.id || 'uno1';
        const boardType = meta.board || boardComp?.type || 'wokwi-arduino-uno';
        const compileUnit: any = getBoardCompileFiles(meta, boardCompId);
        
        let firmwareHex = meta.hex || boardComp?.attrs?.firmwareHex || boardComp?.attrs?.hex || "";

        // Detection: Is this source code instead of HEX?
        const sourceCode = compileUnit.mainCode || "";
        const isSourceCode = sourceCode.startsWith('#') || 
                             sourceCode.includes('void setup') || 
                             sourceCode.includes('void loop') ||
                             sourceCode.includes('int main');
        
        if (isSourceCode && !firmwareHex) {
            postMessage({ type: 'LOG', msg: `[v2.8] ${label}: Source code detected (${sourceCode.length} chars). Compiling for ${boardCompId}...` });
            // Log the full code for inspection
            postMessage({ type: 'LOG', msg: `--- BEGIN SOURCE ---\n${sourceCode}\n--- END SOURCE ---` });
            
            try {
                firmwareHex = await compileSourceCode({
                    code: sourceCode,
                    files: compileUnit.files,
                    sketchName: compileUnit.sketchName
                }, boardType);
                postMessage({ type: 'LOG', msg: `[v2.8] ${label}: Compilation successful.` });
            } catch (compileErr: any) {
                postMessage({ type: 'LOG', msg: `[v2.8] Warning: ${label} compilation failed: ${compileErr?.message || String(compileErr)}`, logType: 'warning' });
            }
        }

        console.log(`[TRACE] ${label}: Starting capture behavior. Source detected: ${isSourceCode}, Hex Length: ${firmwareHex?.length || 0}`);
        postMessage({ type: 'LOG', msg: `[TRACE] ${label}: Initializing Runner for ${boardType} at ${normalizedSpeed}x speed (telemetry cutoff: ${effectiveCutoffMs}ms)...` });

        runner = await createRunnerForBoard(
            meta.board || boardComp?.type || 'wokwi-arduino-uno',
            firmwareHex,
            meta.components || [],
            meta.connections || [],
            (state: any) => {
                const nowMs = runner.getSimulatedTimeMs();
                if (state.type === 'state' && state.pins) {
                    for (const pinId in state.pins) {
                        const newState = !!state.pins[pinId];
                        if (newState !== lastPinStates[pinId]) {
                            pushTelemetryEvent({
                                PinChange: { pin: pinId, state: newState, time_ms: nowMs }
                            }, nowMs);
                            lastPinStates[pinId] = newState;
                        }
                    }
                } else if (state.type === 'serial') {
                    pushTelemetryEvent({
                        SerialOutput: { data: state.data, time_ms: nowMs }
                    }, nowMs);
                    telemetry.serial += state.data;
                }
            },
            { speed: normalizedSpeed }
        );
        
        runner.setTelemetryEnabled(true);
        const simStartMs = runner.getSimulatedTimeMs();
        let lastTraceTime = 0;
        
        console.log(`[TRACE] ${label}: Simulation loop entered.`);

        while (runner.getSimulatedTimeMs() - simStartMs < durationMs) {
            const pollIntervalMs = Math.max(2, Math.round(50 / normalizedSpeed));
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

            const nowMs = runner.getSimulatedTimeMs();
            if (nowMs - lastTraceTime > 1000) {
                console.log(`[TRACE] ${label}: Progress -> ${Math.round(nowMs)}ms / ${durationMs}ms`);
                postMessage({ type: 'LOG', msg: `[TRACE] ${label}: Simulating... ${Math.round(nowMs)}ms @ ${normalizedSpeed}x` });
                lastTraceTime = nowMs;
            }
            
            const snapshot = runner.getRichTelemetrySnapshot({ mode: 'delta' });
            
            if (snapshot.components) {
                for (const comp of snapshot.components) {
                    if (!comp.delta) continue;
                    const cid = comp.id;
                    const custom = comp.metrics?.custom || {};
                    for (const key in custom) {
                        const val = custom[key];
                        const stateKey = `${cid}:${key}`;
                        
                        // Per-key filtering for extreme cleanliness
                        if (JSON.stringify(val) !== JSON.stringify(lastComponentStates[stateKey])) {
                            pushTelemetryEvent({ 
                                ComponentState: { id: cid, key: key, value: val, time_ms: nowMs } 
                            }, nowMs);
                            lastComponentStates[stateKey] = JSON.parse(JSON.stringify(val));
                        }
                    }
                }
            }

            const wallTimeoutMs = Math.max(30000, Math.ceil(30000 / normalizedSpeed));
            if (Date.now() - startTime > wallTimeoutMs) { // Guard against stuck emulation while supporting higher speed runs
                console.warn(`[v2.4] ${label} simulation timed out!`);
                break;
            }
        }
        
        const richSnapshot = runner.getRichTelemetrySnapshot({ mode: 'deep' });
        telemetry.rich_metrics = JSON.stringify(richSnapshot);
        (telemetry as any).simulation_speed = normalizedSpeed;
        (telemetry as any).telemetry_cutoff_ms = effectiveCutoffMs;
        (telemetry as any).events = telemetry.events.filter((evt: any) => {
            const eventType = Object.keys(evt || {})[0];
            const eventData = eventType ? evt?.[eventType] : null;
            const eventTime = Number(eventData?.time_ms);
            return Number.isFinite(eventTime) && eventTime <= effectiveCutoffMs;
        });
        
        runner.stop();
        sendJsonLog(`[v2.3] ${label} complete. (${telemetry.events.length} events, speed=${normalizedSpeed}x, cutoff=${effectiveCutoffMs}ms)`, 'info');
        return telemetry;
    } catch (err: any) {
        const errorMsg = String(err);
        postMessage({ type: 'LOG', msg: `[v2.3] ERROR: ${label} simulation failed: ${errorMsg}`, logType: 'error' });
        telemetry.error = errorMsg;
        telemetry.crashed = true;
        // Ensure runner is stopped if possible
        try { if (runner && runner.stop) runner.stop(); } catch (e) {}
        return telemetry;
    }
}

function detectSourceCode(code: string): boolean {
    if (!code || code.length < 20) return false;
    const hasArduinoMarkers = /\b(void\s+setup|void\s+loop|pinMode|digitalWrite|Serial\.begin|delay)\s*\(/.test(code);
    const hasIncludes = /#\s*include\s+["<]/.test(code);
    const hasMain = /\bint\s+main\s*\(/.test(code);
    const looksLikeHex = /^[0-9a-fA-F:\s]+$/.test(code.trim());
    return (hasArduinoMarkers || hasIncludes || hasMain) && !looksLikeHex;
}

onmessage = async (e: MessageEvent<GradingMessage>) => {
    const { type, teacher, student, options, simulationSpeed } = e.data;
    const runSpeed = Number.isFinite(simulationSpeed) && (simulationSpeed as number) > 0 ? Number(simulationSpeed) : 1;
    console.log(`[HEARTBEAT] Worker: Message Received -> ${type}`);
    try {
        await initEngine();
        
        if (type === 'GENERATE_KEY') {
            const teacherData = teacher as any;
            postMessage({ type: 'LOG', msg: "Generating Reference Key: Running simulation..." });
            sendJsonLog(`[Run Config] mode=GENERATE_KEY speed=${runSpeed}x telemetry_cutoff_ms=7900`, 'info');
            
            let teacherMeta;
            let projectJson: string;
            
            if (teacherData.project && teacherData.project.startsWith('{')) {
                projectJson = teacherData.project;
                teacherMeta = JSON.parse(projectJson);
            } else {
                const buf = teacherData.projectBuf || teacher;
                projectJson = extractProjectMetaFromPng(new Uint8Array(buf as any));
                teacherMeta = JSON.parse(projectJson);
            }

            // Teacher Validation Gate
            postMessage({ type: 'LOG', msg: "Auditing Teacher Reference Circuit..." });
            const validator = new emulatorExports.FullCircuitValidator(teacherMeta);
            validator.runValidation();
            const syncResult = emulatorExports.analyzeCodeHardwareSync(teacherMeta);
            const teacherHealth = validator.calculateHealthScore(syncResult.issues);

            if (teacherHealth < 100) {
                postMessage({ type: 'LOG', msg: `[Warning] Teacher's reference circuit has spatial/electrical errors! Health: ${teacherHealth}%`, logType: 'warning' });
            }

            postMessage({ type: 'LOG', msg: `[TRACE] Teacher key capture speed: ${runSpeed}x` });
            const telemetry = await captureBehavior(teacherMeta, 8000, "Teacher Reference", runSpeed);
            const key = wasmExports.generate_binary_key(
                projectJson, 
                JSON.stringify(telemetry),
                teacherHealth,
                JSON.stringify(validator.errors.map((e: any) => e.message))
            );
            postMessage({ type: 'KEY_GENERATED', key });

        } else if (type === 'GRADE' && student) {
            postMessage({ type: 'LOG', msg: "Starting Intelligent Grading Process..." });
            sendJsonLog(`[Run Config] mode=GRADE speed=${runSpeed}x telemetry_cutoff_ms=7900`, 'info');
            
            // 1. Student Metadata
            const studentMeta = extractProjectMetaFromPng(new Uint8Array(student));

            // 2. RUN VALIDATION ENGINE (Electrical Safety & Sync)
            postMessage({ type: 'LOG', msg: "Running Electrical Safety & Sync Validation..." });
            const validator = new emulatorExports.FullCircuitValidator(studentMeta);
            validator.runValidation();
            const syncResult = emulatorExports.analyzeCodeHardwareSync(studentMeta);
            
            // 3. Behavioral Analysis (Teacher - IF PNG)
            let teacherBinaryKey: Uint8Array;
            if (teacher instanceof ArrayBuffer) {
                postMessage({ type: 'LOG', msg: "Teacher reference is a PNG. Generating behavioral baseline first..." });
                const teacherMeta = extractProjectMetaFromPng(new Uint8Array(teacher));
                const teacherMetaJson = JSON.stringify(teacherMeta);
                
                // Teacher Validation (Audit)
                const tValidator = new emulatorExports.FullCircuitValidator(teacherMeta);
                tValidator.runValidation();
                const tSync = emulatorExports.analyzeCodeHardwareSync(teacherMeta);
                const tHealth = tValidator.calculateHealthScore(tSync.issues);
                
                postMessage({ type: 'LOG', msg: `[TRACE] Teacher capture speed: ${runSpeed}x` });
                const teacherTelemetry = await captureBehavior(teacherMeta, 8000, "Teacher Reference", runSpeed);
                teacherBinaryKey = wasmExports.generate_binary_key(
                    teacherMetaJson, 
                    JSON.stringify(teacherTelemetry),
                    tHealth,
                    JSON.stringify(tValidator.errors.map((e: any) => e.message))
                );
            } else {
                teacherBinaryKey = new Uint8Array(teacher as any);
            }

            // 4. Behavioral Analysis (Student)
            postMessage({ type: 'LOG', msg: `[TRACE] Student capture speed: ${runSpeed}x` });
            const studentTelemetry = await captureBehavior(studentMeta, 8000, "Student Submission", runSpeed);

            // 5. BEHAVIOR-CORRECTED HEALTH (Trusting the simulation results over static analysis)
            const activeComponentIds = new Set(
                studentTelemetry.events
                    .filter((e: any) => e.ComponentState)
                    .map((e: any) => e.ComponentState.id)
            );

            const correctedErrors = validator.errors.filter((err: any) => {
                // If safety engine says "unconnected" but simulation says "it's glowing", ignore the error
                if (err.message.includes("unconnected")) {
                    const match = err.message.match(/\[.* (.*)\]/);
                    const compId = match ? match[1] : null;
                    if (compId && activeComponentIds.has(compId)) {
                        postMessage({ type: 'LOG', msg: `[Outcome Verification] Overriding unconnected error for ${compId} (Functional activity detected).`, logType: 'success' });
                        return false;
                    }
                }
                return true;
            });

            validator.errors = correctedErrors;
            const healthScore = validator.calculateHealthScore(syncResult.issues);
            postMessage({ type: 'LOG', msg: `[Validation] Final Health Score: ${healthScore}%` });

            const validationErrors = [
                ...correctedErrors.map((e: any) => `Safety: ${e.message}`),
                ...syncResult.issues.map((e: any) => `Sync: ${e.message}`)
            ];

            postMessage({ type: 'LOG', msg: "[v2.2] Running Final Comparison (Rust/WASM)..." });
            const result = wasmExports.grade_circuits_wasm(
                new Uint8Array(student),
                teacherBinaryKey,
                JSON.stringify(studentTelemetry),
                {
                    ...options,
                    simulation_speed: runSpeed,
                    validation_health: healthScore,
                    validation_errors: validationErrors
                }
            );

            const finalResult = result && typeof result === 'object' ? { ...result } : result;
            if (finalResult && typeof finalResult === 'object') {
                (finalResult as any).simulation_speed = runSpeed;
                (finalResult as any).telemetry_cutoff_ms = 7900;
                if (Array.isArray((finalResult as any).logs)) {
                    (finalResult as any).logs = (finalResult as any).logs.map((line: any) => `[${runSpeed}x] ${String(line)}`);
                }
                const codeScore = Number(finalResult.code_score);
                const pinFidelity = Number(finalResult.pin_fidelity);
                const verifiedScore = Number(finalResult.verified_code_score);

                if ((verifiedScore === 0 || !Number.isFinite(verifiedScore)) && codeScore > 0 && pinFidelity > 0) {
                    finalResult.verified_code_score = Math.round((codeScore * 0.70) + (pinFidelity * 0.30));
                    sendJsonLog(`[v2.2] Recomputed verified code score from Rust fields: ${finalResult.verified_code_score}%`, 'warning');
                }

                if (!finalResult.temporal_breakdown && finalResult.teacher_telemetry && finalResult.student_telemetry) {
                    finalResult.temporal_breakdown = null;
                }
            }
            
            // Emit grading complete log then send result and a downloadable JSON report
            sendJsonLog('Grading complete. Report generated.', 'info');

            const report = {
                generated_at: new Date().toISOString(),
                result: finalResult,
                teacherBinaryKey: Array.from(new Uint8Array(teacherBinaryKey || [])),
                logs: jsonLogs,
                model_diagnostics: null
            };

            // Send report as structured JSON payload (main thread can offer download)
            postMessage({ type: 'DOWNLOAD_REPORT', report: JSON.stringify(report, null, 2) });

            postMessage({ 
                type: 'GRADING_COMPLETE', 
                result: finalResult,
                teacherBinaryKey: teacherBinaryKey 
            });
        } else if (type === 'MERGE_AI_RESULTS') {
            // Option B: Merge AI audit results with grading report and emit merged download
            const { aiResult, gradingResult } = e.data as any;
            if (!aiResult || !gradingResult) {
                postMessage({ type: 'MERGE_ERROR', error: 'Missing AI or grading result' });
                return;
            }
            
            const mergedReport = {
                generated_at: new Date().toISOString(),
                grading_result: gradingResult,
                ai_result: aiResult,
                ai_logs: aiResult.aiLogs || [],
                model_diagnostics: aiResult.modelDiagnostics || null,
                all_logs: [...jsonLogs, ...(aiResult.aiLogs || [])]
            };
            postMessage({ type: 'DOWNLOAD_REPORT_MERGED', report: JSON.stringify(mergedReport, null, 2) });
        }
    } catch (globalErr) {
        sendJsonLog(`CRITICAL ERROR: ${globalErr}`, 'error');
        postMessage({ 
            type: 'GRADING_COMPLETE', 
            result: { 
                score: 0, 
                feedback: [`Internal Engine Error: ${globalErr}`],
                logs: [`Fatal: ${globalErr}`]
            } 
        });
    }
};
