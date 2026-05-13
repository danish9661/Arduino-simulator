# RECOMMENDED CODE PATCHES FOR AUTO-GRADING

## PATCH 1: Fix WASM Initialization Race Condition

**File:** `src/worker/grading-engine.worker.ts`

**Current (BROKEN):**
```typescript
let isInitialized = false;

async function initEngine() {
    if (isInitialized) return;
    console.log("[HEARTBEAT] Worker: initEngine() started...");
    
    wasmExports = await import('../wasm/grading/openhw_studio_grading_engine.js');
    // ... more initialization
    isInitialized = true;
}
```

**Patched (SAFE):**
```typescript
let isInitialized = false;
let initPromise: Promise<void> | null = null;

async function initEngine() {
    if (initPromise) return initPromise;
    
    initPromise = (async () => {
        try {
            if (isInitialized) return;
            
            console.log("[HEARTBEAT] Worker: initEngine() started...");
            postMessage({ type: 'LOG', msg: "Loading Grading Engine (WASM)..." });

            wasmExports = await import('../wasm/grading/openhw_studio_grading_engine.js');
            const wasmUrlMod = await import('../wasm/grading/openhw_studio_grading_engine_bg.wasm?url');
            const wasmUrl = wasmUrlMod.default;

            await wasmExports.default(wasmUrl);
            console.log("[HEARTBEAT] Worker: WASM initialized.");
            
            if (wasmExports.init_panic_hook) {
                wasmExports.init_panic_hook();
                console.log("[HEARTBEAT] Worker: Panic hook initialized.");
            }

            emulatorExports = await import("@openhw/emulator");
            console.log("[HEARTBEAT] Worker: Emulator logic loaded.");

            isInitialized = true;
            postMessage({ type: 'LOG', msg: "Grading Engine (WASM + Logic) Ready." });
        } catch (err) {
            console.error("[HEARTBEAT] Worker: DYNAMIC INIT FAILED:", err);
            postMessage({ type: 'LOG', msg: `CRITICAL: Init Failed: ${err.message}`, logType: 'error' });
            initPromise = null;  // Reset on failure to allow retry
            throw err;
        }
    })();
    
    return initPromise;
}
```

---

## PATCH 2: Add emulatorExports Null Check

**File:** `src/worker/grading-engine.worker.ts`

**Current (BROKEN):**
```typescript
const validator = new emulatorExports.FullCircuitValidator(studentMeta);
const syncResult = emulatorExports.analyzeCodeHardwareSync(studentMeta);
```

**Patched (SAFE):**
```typescript
// Add validation helper
function validateEmulatorExports() {
    if (!emulatorExports) {
        throw new Error('CRITICAL: Emulator logic not initialized. Call initEngine() first.');
    }
    if (!emulatorExports.FullCircuitValidator) {
        throw new Error('CRITICAL: FullCircuitValidator not found in emulator exports.');
    }
    if (!emulatorExports.analyzeCodeHardwareSync) {
        throw new Error('CRITICAL: analyzeCodeHardwareSync not found in emulator exports.');
    }
}

// Before using:
validateEmulatorExports();
const validator = new emulatorExports.FullCircuitValidator(studentMeta);
const syncResult = emulatorExports.analyzeCodeHardwareSync(studentMeta);
```

---

## PATCH 3: Fix PNG Metadata Decode Error Handling

**File:** `src/pages/simulationpage/SimulatorPage.jsx`

**Current (BROKEN):**
```javascript
const jsonStr = new TextDecoder('utf-8', { fatal: false }).decode(payloadBytes);
const meta = JSON.parse(jsonStr);
applyImportedProjectMeta(meta, 'PNG project');
```

**Patched (SAFE):**
```javascript
try {
    // Use strict UTF-8 decoding to catch encoding errors
    const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    
    // Validate JSON structure before parsing
    if (!jsonStr.trim().startsWith('{')) {
        throw new Error('Metadata is not valid JSON (does not start with {)');
    }
    
    const meta = JSON.parse(jsonStr);
    
    // Validate required fields
    if (!meta.components || !Array.isArray(meta.components)) {
        throw new Error('Invalid metadata: missing components array');
    }
    
    applyImportedProjectMeta(meta, 'PNG project');
    
} catch (err) {
    console.error('[PNG Import] Metadata corruption detected:', err);
    alert(
        `Cannot import this PNG file. The metadata is corrupted or invalid.\n\n` +
        `Error: ${err.message}\n\n` +
        `This usually means the PNG was modified after export or is from an ` +
        `incompatible version of OpenHW Studio.`
    );
    if (importFileRef.current) importFileRef.current.value = '';
    return;
}
```

---

## PATCH 4: Fix Silent Board Fallback

**File:** `src/utils/projectCompilerUtils.js`

**Current (BROKEN):**
```javascript
let targetBoardId = boardId;

// Safety fallback for board discovery
const hasFilesForBoard = projectFiles.some(f => f.path.startsWith(`project/${targetBoardId}/`));
if (!hasFilesForBoard) {
    const firstBoardFile = projectFiles.find(f => f.path.startsWith('project/'));
    if (firstBoardFile) {
        const match = firstBoardFile.path.match(/^project\/([^/]+)\//);
        if (match) targetBoardId = match[1];  // ← Silently changes
    }
}
```

**Patched (SAFE):**
```javascript
let targetBoardId = boardId;

// Safety fallback for board discovery
const hasFilesForBoard = projectFiles.some(f => f.path.startsWith(`project/${targetBoardId}/`));
if (!hasFilesForBoard) {
    const availableBoardFiles = projectFiles.filter(f => f.path.startsWith('project/'));
    
    if (availableBoardFiles.length === 0) {
        throw new Error(
            `Project has no source code for board "${boardId}". ` +
            `The project appears to be empty or corrupted.`
        );
    }
    
    const firstBoardFile = availableBoardFiles[0];
    const match = firstBoardFile.path.match(/^project\/([^/]+)\//);
    const discoveredBoardId = match ? match[1] : null;
    
    if (discoveredBoardId) {
        const availableBoards = [...new Set(
            availableBoardFiles.map(f => {
                const m = f.path.match(/^project\/([^/]+)\//);
                return m ? m[1] : null;
            }).filter(Boolean)
        )];
        
        console.warn(
            `[Board Mismatch] Requested board "${boardId}" not found. ` +
            `Available boards: ${availableBoards.join(', ')}. ` +
            `Using "${discoveredBoardId}" for compilation.`
        );
        
        // Only silently fallback if exactly one board available
        if (availableBoards.length === 1) {
            targetBoardId = discoveredBoardId;
        } else {
            throw new Error(
                `Multiple boards found (${availableBoards.join(', ')}) ` +
                `but requested board "${boardId}" not in this project.`
            );
        }
    }
}

// Return warning info for logging
return { targetBoardId, boardMismatch: targetBoardId !== boardId };
```

---

## PATCH 5: Fix Simulation Crash Silent Failure

**File:** `src/worker/grading-engine.worker.ts`

**Current (BROKEN):**
```typescript
async function captureBehavior(meta: any, durationMs: number, label: string): Promise<any> {
    const telemetry = {
        events: [] as any[],
        serial: "",
        duration_ms: durationMs
    };
    
    try {
        // ... simulation code
    } catch (err) {
        postMessage({ type: 'LOG', msg: `[v2.3] Warning: ${label} simulation failed: ${err}`, logType: 'warning' });
        return telemetry;  // ← EMPTY! Can't distinguish from success
    }
}
```

**Patched (SAFE):**
```typescript
async function captureBehavior(meta: any, durationMs: number, label: string): Promise<any> {
    const telemetry = {
        events: [] as any[],
        serial: "",
        duration_ms: durationMs,
        error: null as string | null,
        crashed: false
    };
    
    try {
        // ... simulation code
        return telemetry;
    } catch (err) {
        const errorMsg = String(err);
        postMessage({ 
            type: 'LOG', 
            msg: `[ERROR] ${label} simulation failed: ${errorMsg}`, 
            logType: 'error' 
        });
        
        // Return telemetry marked as crashed
        telemetry.error = errorMsg;
        telemetry.crashed = true;
        telemetry.events = [];  // Clear any partial events
        
        return telemetry;
    }
}
```

Then in grading logic, check for crash:

```typescript
const studentTelemetry = await captureBehavior(studentMeta, 8000, "Student Submission");

if (studentTelemetry.crashed) {
    postMessage({ 
        type: 'LOG', 
        msg: `[CRITICAL] Student simulation crashed: ${studentTelemetry.error}`, 
        logType: 'error' 
    });
    
    postMessage({
        type: 'GRADING_COMPLETE',
        result: {
            score: 0,
            spatial_score: 0,
            logic_score: 0,
            behavioral_score: 0,
            code_score: 0,
            feedback: [
                'Student submission simulation crashed.',
                'This usually indicates:',
                '- Infinite loop in code',
                '- Memory exhaustion',
                '- Invalid circuit configuration',
                `Error: ${studentTelemetry.error}`
            ]
        }
    });
    return;
}
```

---

## PATCH 6: Fix Source Code Detection

**File:** `src/worker/grading-engine.worker.ts`

**Current (FRAGILE):**
```typescript
const sourceCode = compileUnit.mainCode || "";
const isSourceCode = sourceCode.startsWith('#') || 
                     sourceCode.includes('void setup') || 
                     sourceCode.includes('void loop') ||
                     sourceCode.includes('int main');
```

**Patched (ROBUST):**
```typescript
function detectSourceCode(code: string): boolean {
    if (!code || code.length < 20) return false;
    
    // Check for Arduino-specific patterns (word boundaries)
    const hasArduinoMarkers = /\b(void\s+setup|void\s+loop|pinMode|digitalWrite|Serial\.begin|delay)\s*\(/.test(code);
    
    // Check for C/C++ patterns
    const hasIncludes = /#\s*include\s+["<]/.test(code);
    const hasMainFunction = /\bvoid\s+setup\s*\(|int\s+main\s*\(/.test(code);
    const hasStructure = /\{[\s\S]*\}/.test(code);  // Has curly braces
    
    // Check for typical HEX patterns (unlikely in source)
    const looksLikeHex = /^[0-9a-fA-F:]+$/.test(code.trim());
    
    return (hasArduinoMarkers || hasIncludes || hasMainFunction) && !looksLikeHex;
}

const sourceCode = compileUnit.mainCode || "";
const isSourceCode = detectSourceCode(sourceCode);
```

---

## PATCH 7: Handle Board Mismatch in Worker

**File:** `src/worker/grading-engine.worker.ts`

**Add this check after extracting metadata:**

```typescript
// 1. Student Metadata
const studentMetaJson = wasmExports.extract_project_meta(new Uint8Array(student));
const studentMeta = JSON.parse(studentMetaJson);

// 2. Get compilation units to detect board mismatch
const studentCompileUnit = getBoardCompileFiles(studentMeta, boardCompId);

// Check if board was changed during compilation
if (studentCompileUnit.boardMismatch) {
    postMessage({
        type: 'LOG',
        msg: `[WARN]  WARNING: Student board "${boardCompId}" not found. ` +
             `Using discovered board for compilation. ` +
             `Ensure teacher and student use same board!`,
        logType: 'warning'
    });
}
```

---

## PATCH 8: Remove Competing Worker Implementation

**Action:** Delete or archive `src/worker/grading-worker.ts`

**Reason:**
- Orphaned v3.9 implementation creates confusion
- v3.9 (grading-engine.worker.ts) is the active version
- Having two similar files increases maintenance burden
- Risk of developers accidentally using wrong worker

**If v3.9 features are needed:**
- Merge them into v3.9
- Make both implementations identical
- Don't maintain two versions

---

## PATCH 9: Add AI Worker Timeout

**File:** `src/pages/GradingPage.jsx`

**Current (BROKEN):**
```javascript
const aiWorker = new Worker(new URL('../worker/ai-audit-final.worker.ts', import.meta.url), { type: 'module' });

aiWorker.onmessage = (aiEvent) => {
    // ...
};

aiWorker.postMessage({
    type: 'GRADE_SEMANTICS',
    teacherTelemetry: finalReport.teacher_telemetry,
    studentTelemetry: finalReport.student_telemetry,
    idMapping: finalReport.id_mapping
});
```

**Patched (WITH TIMEOUT):**
```javascript
const aiWorker = new Worker(new URL('../worker/ai-audit-final.worker.ts', import.meta.url), { type: 'module' });

const AI_TIMEOUT = 120000; // 2 minutes
let aiTimeoutHandle: NodeJS.Timeout | null = null;

aiWorker.onmessage = (aiEvent) => {
    if (aiTimeoutHandle) clearTimeout(aiTimeoutHandle);
    
    const aiData = aiEvent.data;
    if (aiData.type === 'STATUS') {
        addLog(`AI Auditor: ${aiData.msg}`, 'info');
    } else if (aiData.type === 'RESULT') {
        addLog(`AI Semantic Score: ${(aiData.score * 100).toFixed(1)}%`, 'success');
        // ... merge results
        aiWorker.terminate();
    } else if (aiData.type === 'ERROR') {
        addLog(`AI Auditor Error: ${aiData.error}`, 'error');
        aiWorker.terminate();
    }
};

aiWorker.onerror = (err) => {
    if (aiTimeoutHandle) clearTimeout(aiTimeoutHandle);
    addLog(`AI Worker Fatal Error: ${err.message}`, 'error');
    aiWorker.terminate();
};

aiTimeoutHandle = setTimeout(() => {
    addLog('AI Auditor timed out after 2 minutes. Skipping semantic validation.', 'warning');
    aiWorker.terminate();
    setReport(prev => prev ? { ...prev, ai_status: 'Timeout' } : null);
}, AI_TIMEOUT);

aiWorker.postMessage({
    type: 'GRADE_SEMANTICS',
    teacherTelemetry: finalReport.teacher_telemetry,
    studentTelemetry: finalReport.student_telemetry,
    idMapping: finalReport.id_mapping
});
```

---

## PATCH 10: Cache Key Type Consistency

**File:** `src/pages/GradingPage.jsx`

**Current (TYPE CONFUSION):**
```javascript
let teacherData;
if (teacherKeyCacheRef.current.hash === fileHash && teacherKeyCacheRef.current.key) {
    teacherData = teacherKeyCacheRef.current.key;  // ← Could be Uint8Array
} else {
    teacherData = await teacherFile.arrayBuffer();  // ← Always ArrayBuffer
}
```

**Patched (CONSISTENT TYPE):**
```javascript
let teacherData: ArrayBuffer | Uint8Array;

if (teacherKeyCacheRef.current.hash === fileHash && teacherKeyCacheRef.current.key) {
    addLog('Using cached Teacher Reference Key (Simulation skipped).', 'success');
    
    // Convert cached Uint8Array back to ArrayBuffer for consistency
    const cachedKey = teacherKeyCacheRef.current.key;
    if (cachedKey instanceof Uint8Array) {
        teacherData = cachedKey.buffer.slice(
            cachedKey.byteOffset,
            cachedKey.byteOffset + cachedKey.byteLength
        ) as ArrayBuffer;
    } else if (cachedKey instanceof ArrayBuffer) {
        teacherData = cachedKey;
    } else {
        throw new Error('Invalid cached key type');
    }
} else {
    const reason = !teacherKeyCacheRef.current.key 
        ? 'No key in memory' 
        : `Hash Mismatch`;
    addLog(`Cache Miss: Simulation required. Reason: ${reason}`, 'info');
    teacherData = await teacherFile.arrayBuffer();
}
```

---

## DEPLOYMENT CHECKLIST

- [ ] Apply PATCH 1: Fix WASM init race condition
- [ ] Apply PATCH 2: Add emulatorExports validation
- [ ] Apply PATCH 3: PNG metadata error handling
- [ ] Apply PATCH 4: Board fallback detection
- [ ] Apply PATCH 5: Simulation crash detection
- [ ] Apply PATCH 6: Better source detection
- [ ] Apply PATCH 7: Board mismatch warning
- [ ] Delete or merge PATCH 8: Competing worker
- [ ] Apply PATCH 9: AI worker timeout
- [ ] Apply PATCH 10: Cache type consistency
- [ ] Run comprehensive test suite
- [ ] Test scenarios from CRITICAL_ISSUES_QUICK_REF.md



