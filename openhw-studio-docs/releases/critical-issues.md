# CRITICAL ISSUES - QUICK REFERENCE

## 🔴 WILL CAUSE CRASHES

### 1. Two Competing Worker Implementations
- **v3.9 `grading-worker.ts`** - Direct WASM imports (orphaned)
- **v3.9 `grading-engine.worker.ts`** - Dynamic loader with polyfills (ACTIVE)
- **Result:** If both initialize, emulatorExports undefined crash
- **File:** GradingPage.jsx line 3

### 2. WASM Initialization Race Condition
```typescript
let isInitialized = false;
async function initEngine() {
    if (isInitialized) return;  // ← UNSAFE
    await init(wasmUrl);
    isInitialized = true;
}
```
- **Result:** Multiple concurrent GRADE messages cause double init
- **Impact:** Conflicting panic hooks, memory leaks, undefined behavior

### 3. Missing emulatorExports Null Check
```typescript
await initEngine();
const validator = new emulatorExports.FullCircuitValidator(studentMeta);
// ^^^^^^^^^^^^^^^^ CRASH if emulatorExports is undefined
```
- **File:** grading-engine.worker.ts line 313+

---

## 🟠 HIGH SEVERITY - SILENT FAILURES

### 4. Silent Board Discovery Fallback
```javascript
// If teacher board = "uno", student board = "pico"
// projectCompilerUtils silently compiles both on DIFFERENT boards
// Result: 0% match, no warning
```
- **File:** projectCompilerUtils.js line 40-50

### 5. Simulation Crash Returns Empty Telemetry
```typescript
catch (err) {
    return telemetry;  // { events: [], serial: "", ... }
    // Grading proceeds with 0% behavioral score
    // Can't distinguish crash from "perfect code"
}
```
- **File:** Both workers, captureBehavior()

### 6. PNG Metadata Decode No Error Handling
```javascript
const jsonStr = new TextDecoder('utf-8', { fatal: false }).decode(payloadBytes);
const meta = JSON.parse(jsonStr);  // ← Silent fail if invalid
```
- **File:** SimulatorPage.jsx line 8690+

---

## 🟡 MEDIUM SEVERITY - DATA CORRUPTION RISKS

### 7. WASM Panic Hook Not Guaranteed
- If `init()` fails, `init_panic_hook()` still executes on nothing
- Later panics crash worker with no diagnostic

### 8. Key Type Confusion (ArrayBuffer vs Uint8Array)
```javascript
// First use: ArrayBuffer
teacherData = await teacherFile.arrayBuffer();
// After cache: Uint8Array
teacherData = teacherKeyCacheRef.current.key;
```
- Worker checks `teacher instanceof ArrayBuffer` - breaks after first run

### 9. AI Worker No Timeout
- Spawned in GradingPage but no timeout
- If model fails to load, UI hangs indefinitely

### 10. Message Protocol Drift (v3.9 vs v3.9)
- v3.9 sends extra data in response
- Message type inconsistencies
- `result.logs` expected but not guaranteed

---

## FAILURE SCENARIOS (Will Happen)

| Scenario | Result |
|----------|--------|
| Grade twice in succession | Race condition crashes worker |
| PNG with encoding issues | Silent data loss |
| No .ino file in project | Wrong file becomes main code |
| WASM network timeout | Worker hangs |
| Teacher/Student different boards | 0% match, no warning |
| Simulation crashes | Misleading 0% score |

---

## FILES INVOLVED

```
WORKERS (2 incompatible versions):
├── grading-worker.ts (v3.9) - orphaned, direct imports
└── grading-engine.worker.ts (v3.9) - active, dynamic polyfills

UI COORDINATOR:
└── GradingPage.jsx - calls v3.9 worker, spawns AI worker

PNG PIPELINE:
└── SimulatorPage.jsx - importPng(), downloadPng(), downloadPngWasm()

COMPILATION PIPELINE:
└── projectCompilerUtils.js - getBoardCompileFiles() (SOURCE OF TRUTH)

AI WORKER:
└── ai-audit-final.worker.ts - semantic validation

WASM MODULES:
├── grading-engine.js/wasm (main grading)
├── autofix_rust.js/wasm
├── autowiring_engine.js/wasm
└── canvas_engine.js/wasm
```

---

## QUICK FIXES

### FIX #1: WASM Init Race Condition
```typescript
let initPromise: Promise<void> | null = null;

async function initEngine() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            await init(wasmUrl);
            if (wasmExports?.init_panic_hook) wasmExports.init_panic_hook();
        } catch (err) {
            initPromise = null;  // Reset on failure for retry
            throw err;
        }
    })();
    return initPromise;
}
```

### FIX #2: Remove Competing Worker
```javascript
// DELETE grading-worker.ts completely
// Keep ONLY grading-engine.worker.ts (v3.9)
// OR make both identical
```

### FIX #3: Board Mismatch Detection
```javascript
if (!hasFilesForBoard && firstBoardFile) {
    const newId = match[1];
    throw new Error(
        `Board '${boardId}' not found in project. ` +
        `Available: '${newId}'. If intentional, use project compiler utils.`
    );
}
```

### FIX #4: PNG Decode Error Handling
```javascript
try {
    const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    const meta = JSON.parse(jsonStr);
    applyImportedProjectMeta(meta, 'PNG project');
} catch (err) {
    alert(`PNG metadata corrupted: ${err.message}`);
    return;
}
```

### FIX #5: Distinguish Simulation Crash
```typescript
catch (err) {
    const failedTelemetry = {
        ...telemetry,
        error: String(err),
        simulationCrashed: true
    };
    postMessage({ type: 'LOG', msg: `Simulation failed: ${err}` });
    return failedTelemetry;
}
```

---

## TESTING CHECKLIST

- [ ] Run grading twice in succession (race condition test)
- [ ] Upload PNG with non-ASCII characters (encoding test)
- [ ] Upload PNG with non-existent board (fallback test)
- [ ] Upload project without .ino file (main file detection test)
- [ ] Simulate network timeout during WASM load (error recovery test)
- [ ] Grade teacher/student projects on different boards (compatibility test)
- [ ] Trigger grading simulation crash (telemetry test)
- [ ] Load corrupted PNG metadata (error handling test)



