# AUTO-GRADING SYSTEM COMPREHENSIVE AUDIT REPORT

**Date:** May 8, 2026  
**Scope:** Full architecture audit covering Engine, Workers, UI, WASM, PNG handling, and compilation pipeline

---

## 1. CRITICAL INITIALIZATION COMPATIBILITY ISSUES

### 1.1 **Two Competing Worker Implementations - COLLISION RISK [WARN]**

**Location:** GradingPage.jsx line 3
```javascript
import GradingWorker from '../worker/grading-engine.worker.ts?worker';
```

**Problem:**
- **File conflict:** `grading-worker.ts` (v3.9) vs `grading-engine.worker.ts` (v3.9) both exist
- **GradingPage only imports v3.9** (dynamic loader), never uses v3.9 (direct WASM)
- **v3.9 is orphaned:** No UI is calling it, but it's maintained and has different error handling
- **Import statement inconsistency:** v3.9 uses dynamic imports; v3.9 uses static imports
- **Message handler incompatibility:** Slightly different log message formats

**Impact:** 
- If developers accidentally call v3.9 worker, it will fail silently with missing emulator exports
- Maintenance nightmare: Two implementations doing similar work but diverging

**What happens if both workers initialize:**
- v3.9 tries direct imports: `import { FullCircuitValidator } from "@openhw/emulator/..."`
- v3.9 tries dynamic imports: `emulatorExports = await import("@openhw/emulator")`
- Both compete for WASM initialization, one will crash with "emulatorExports is undefined"

---

### 1.2 **WASM Initialization Race Condition - Engine Crash 🔴**

**Location:** Both workers (grading-worker.ts line 35, grading-engine.worker.ts line 45)

**Problem:**
```typescript
let isInitialized = false;

async function initEngine() {
    if (isInitialized) return;  // ← RACE CONDITION HERE
    console.log("Initializing WASM Engine...");
    await init(wasmUrl);
    init_panic_hook();
    isInitialized = true;
}
```

**Issue:**
- If two messages arrive before `isInitialized` is set to `true`, both will call `await init(wasmUrl)`
- This causes double initialization, leading to:
  - Memory leaks (WASM module loaded twice)
  - Conflicting panic hooks
  - Undefined behavior in WASM bindings

**v3.9 Dynamic Loader Issue:**
```typescript
async function initEngine() {
    if (isInitialized) return;  // ← SAME PROBLEM
    wasmExports = await import('../wasm/grading/...');  // First caller sets this
    const wasmUrl = wasmUrlMod.default;
    await wasmExports.default(wasmUrl);
    if (wasmExports.init_panic_hook) wasmExports.init_panic_hook();  // Can fire twice
    isInitialized = true;
}
```

**Fix Needed:** Use a Promise to serialize initialization
```typescript
let initPromise: Promise<void> | null = null;

async function initEngine() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        // ... actual init code
    })();
    return initPromise;
}
```

---

### 1.3 **Emulator Exports Not Guaranteed at Message Time - v3.9 WASM Reference Crash**

**Location:** grading-engine.worker.ts line 320+

**Problem:**
```typescript
onmessage = async (e: MessageEvent<GradingMessage>) => {
    await initEngine();  // ← initEngine only initializes WASM, not emulatorExports in all cases
    
    // ...
    const validator = new emulatorExports.FullCircuitValidator(studentMeta);
    //     ^^^^^^^^^^^^^^^^ CRASH: emulatorExports might still be undefined!
```

**Why it crashes:**
- `initEngine()` in v3.9 does: `emulatorExports = await import("@openhw/emulator");`
- But if `import()` fails silently or returns empty object, `emulatorExports` is still falsy
- Later code tries to use `emulatorExports.FullCircuitValidator` → TypeError

**v3.9 Comparison (More Robust):**
```typescript
// Direct imports at top level catch errors immediately:
import { FullCircuitValidator } from "@openhw/emulator/src/circuit-validation/engine.js";
```

**Fix Needed:** 
1. v3.9 should throw if emulatorExports is missing
2. v3.9 should be the primary implementation
3. Remove v3.9 or properly validate initialization

---

### 1.4 **Polyfill Side-Effects Breaking Worker Context - v3.9**

**Location:** grading-engine.worker.ts lines 1-10

**Problem:**
```typescript
if (typeof window === 'undefined') {
    (self as any).window = self;  // ← Creates artificial window object
    (self as any).document = {
        createElement: () => ({ style: {} }),
        // ... incomplete mock
    };
}
(self as any).$RefreshReg$ = () => {};  // ← React refresh mocks
(self as any).$RefreshSig$ = () => () => (type: any) => type;
```

**Issues:**
- Mocking `window` in a Worker context can confuse libraries that check for `typeof window`
- Some libraries specifically check `typeof window === 'undefined'` to detect Workers
- Incomplete `document` mock might break dynamic feature detection
- React refresh mocks are unnecessary in a Worker context

**Risk:**
- If a library detects `window` exists, it might try DOM operations → crash
- `@xenova/transformers` (used in AI worker) might have different behavior with fake window

---

## 2. PNG IMPORT/EXPORT COMPATIBILITY ISSUES

### 2.1 **PNG Metadata Marker Inconsistency - Import/Export Mismatch**

**Location:** 
- Export: SimulatorPage.jsx line 7853 `const MARKER = '\x00OPENHW_META\x00';`
- Import: SimulatorPage.jsx line 8678 `const marker = '\x00OPENHW_META\x00';`

**Good News:** Markers match [YES]

**But Issue:** Metadata appending happens AFTER PNG encode:
```javascript
// export
out.toBlob(async (blob) => {
    const pngBuf = await blob.arrayBuffer();
    const pngBytes = new Uint8Array(pngBuf);
    const metaBytes = new TextEncoder().encode(jsonPayload);
    const combined = new Uint8Array(pngBytes.length + metaBytes.length);
    combined.set(pngBytes);
    combined.set(metaBytes, pngBytes.length);
```

**Problem:** If PNG is > 2GB (unlikely but worth noting), or contains binary data that looks like UTF-8 text:
- Import searches from END backwards: `for (let i = bytes.length - markerBytes.length; i >= 0; i--)`
- This is actually correct and safe [YES]

**However:** UTF-8 Decoding Issue:
```javascript
const jsonStr = new TextDecoder('utf-8', { fatal: false }).decode(payloadBytes);
```
- Using `fatal: false` means invalid UTF-8 is silently replaced with replacement character
- Then `JSON.parse(jsonStr)` silently fails or returns garbage
- **No error handling after decode!**

**Fix Needed:**
```javascript
try {
    const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    const meta = JSON.parse(jsonStr);
} catch (err) {
    alert('PNG metadata is corrupted or invalid UTF-8. ' + err.message);
    return;
}
```

---

### 2.2 **PNG Export Cache Not Transferred Between Sessions**

**Location:** SimulatorPage.jsx line 7760
```javascript
const _exportPngResultCache = new Map();  // ← Session-only cache

// ...

if (cached && (Date.now() - cached.createdAt) < CACHE_TTL) {
    // Returns cached PNG
}
```

**Problem:**
- Cache is per-session, lost on page refresh
- WASM PNG export might be slower than expected because cache resets
- No localStorage fallback for large exports

**Not a blocker, but inefficiency**

---

### 2.3 **SVG Sanitization for WASM Export Missing Edge Case**

**Location:** SimulatorPage.jsx line 8085

**Code:**
```javascript
assets[type] = svg.outerHTML
    .replace(/&nbsp;/g, '&#160;')
    .replace(/<br\s*\/?>/gi, ' ');
```

**Problem:**
- Only handles `&nbsp;` and `<br>` tags
- USVG (Rust XML parser) is strict and might reject:
  - HTML entities like `&copy;`, `&reg;` (only XML standard entities allowed: `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`)
  - SVG with namespaced attributes like `xlink:href` if not properly declared
  - Comments or processing instructions

**Fix:** More comprehensive SVG sanitization needed before WASM

---

## 3. PROJECT COMPILATION PIPELINE ISSUES

### 3.1 **projectCompilerUtils.js - Board Discovery Fragility**

**Location:** projectCompilerUtils.js lines 40-50

```javascript
export function getBoardCompileFiles(project, boardId) {
    const projectFiles = normalizeProjectFiles(project.projectFiles);
    
    let targetBoardId = boardId;
    
    // Safety fallback for board discovery
    const hasFilesForBoard = projectFiles.some(f => f.path.startsWith(`project/${targetBoardId}/`));
    if (!hasFilesForBoard) {
        const firstBoardFile = projectFiles.find(f => f.path.startsWith('project/'));
        if (firstBoardFile) {
            const match = firstBoardFile.path.match(/^project\/([^/]+)\//);
            if (match) targetBoardId = match[1];  // ← Silently changes boardId!
        }
    }
```

**Problems:**
1. **Silent fallback:** If requested board doesn't exist, silently uses first board found
   - No warning logged to worker
   - Student submission for "arduino:uno" gets compiled as "rp2040:pico" without notification
2. **Inconsistent with grading:** Teacher graded on "uno" but student compiled on "pico"
3. **No error propagation:** Worker doesn't know compilation unit changed

**Impact in Grading:**
```typescript
// In worker:
const boardCompId = boardComp?.id || 'uno1';  // Assumes 'uno1'
const compileUnit = getBoardCompileFiles(meta, boardCompId);
// If projectCompilerUtils silently uses 'pico1', comparison is between different circuits!
```

**Fix:** Throw error or explicitly warn when board changes
```javascript
if (!hasFilesForBoard && firstBoardFile) {
    const msg = `Requested board '${boardId}' not found. Using '${newId}' instead.`;
    console.warn(msg);
    // Return { warning: msg, mainCode: "", ... } or throw
}
```

---

### 3.2 **Main File Detection Order Can Pick Wrong File**

**Location:** projectCompilerUtils.js lines 53-61

```javascript
const preferredMainName = `${targetBoardId}.ino`;
const main = boardFiles.find((f) => f.name === preferredMainName || f.path.endsWith(preferredMainName))
          || boardFiles.find((f) => fileExt(f.name) === '.ino')
          || boardFiles[0]  // ← Picks ANY first file if no .ino found
          || null;
```

**Problem:**
1. If project has files: `[board.h, board.cpp]` (no .ino), picks `.h` as main
2. Arduino compiler expects `.ino` as entry point
3. Compilation fails with misleading error about .h syntax

**Risk:** Silent compilation failure if no .ino file exists

---

### 3.3 **Disabled Files Not Filtered in Compilation Payload**

**Location:** projectCompilerUtils.js line 68

```javascript
const files = boardFiles
    .filter((f) => !(main && f.path === main.path))
    .map((f) => ({ name: f.name, content: f.content || '' }));
```

**Problem:**
- Files ARE filtered to exclude main file
- But the `isFileDisabled()` check is done on boardFiles (line 39)
- If a file was re-enabled AFTER import, the disabled flag is stale
- Compiler might include .disabled files in the compilation payload

---

## 4. WORKER MESSAGE PROTOCOL INCOMPATIBILITIES

### 4.1 **v3.9 vs v3.9 Response Format Drift**

**v3.9 Final Response:**
```typescript
postMessage({ 
    type: 'GRADING_COMPLETE', 
    result,
    teacherBinaryKey: teacherBinaryKey 
});
```

**v3.9 Final Response:**
```typescript
(self as any).postMessage({ type: 'REPORT', report: finalResult });
postMessage({ 
    type: 'GRADING_COMPLETE', 
    result,
    teacherBinaryKey: teacherBinaryKey 
});
```

**Issues:**
1. v3.9 sends TWO different message types (`REPORT` and `GRADING_COMPLETE`)
2. GradingPage.jsx only listens for `GRADING_COMPLETE` (line 44)
3. `REPORT` message is lost/ignored
4. v3.9 sends extra data in `finalResult` that v3.9 doesn't:
   ```typescript
   teacher_key: teacherBinaryKey,
   teacher_telemetry: teacher instanceof ArrayBuffer ? ... : null,
   student_telemetry: JSON.stringify(studentTelemetry),
   ai_status: "Skipped (Simulation Match Mode)",
   ai_score: 0
   ```

**GradingPage.jsx expects:**
```javascript
if (e.data.type === 'GRADING_COMPLETE') {
    if (e.data.result.logs) {  // ← v3.9 has result.logs?
        e.data.result.logs.forEach(log => addLog(log, 'info'));
    }
    // ...
    const finalReport = e.data.result;
```

**Compatibility Failure:** v3.9 result structure doesn't have `.logs` array

---

### 4.2 **LOG Message Format Inconsistency**

**v3.9 Logs:**
```typescript
postMessage({ type: 'LOG', msg: `[v2.4] ${label} simulation timed out!` });
```

**v3.9 Logs:**
```typescript
postMessage({ type: 'LOG', msg: `[TRACE] ${label}: Starting capture behavior...` });
```

**Problem:**
- Log parsing in GradingPage might expect specific format
- Timestamps inconsistent
- Severity levels different (no logType in some places)

---

### 4.3 **KEY_GENERATED Message Not Handled Identically**

**v3.9:**
```typescript
postMessage({ type: 'KEY_GENERATED', key });
```

**v3.9:**
```typescript
postMessage({ type: 'KEY_GENERATED', key });
```

**Same format**, but v3.9 might send additional data in future updates while v3.9 doesn't.

---

## 5. WASM MODULE INITIALIZATION SEQUENCING

### 5.1 **Panic Hook Setup Order Issue**

**Location:** Both workers after WASM init

```typescript
await init(wasmUrl);
init_panic_hook();  // ← Must be called AFTER init() completes
```

**Problem:**
- If `init()` fails silently, `init_panic_hook()` still executes
- Panic hook might not be attached to the WASM module if init failed
- Later panic crashes the worker with no diagnostic info

---

### 5.2 **Extract Project Meta Called Before WASM Guarantee**

**Location:** grading-worker.ts line 235 (right after initEngine)

```typescript
await initEngine();

if (type === 'GENERATE_KEY') {
    // ...
    projectJson = extract_project_meta(new Uint8Array(buf as any));
    //            ^^^^^^^^^^^^^^^^^^^^^^ What if initEngine failed silently?
```

**Problem:**
- `initEngine()` doesn't throw on failure in either version
- If WASM wasn't loaded, `extract_project_meta` function doesn't exist
- Calls `undefined()` → TypeError

---

## 6. CROSS-WORKER DEPENDENCY ISSUES

### 6.1 **AI-Audit Worker Spawned Without Guarantee of Results**

**Location:** GradingPage.jsx line 52-83

```javascript
const aiWorker = new Worker(new URL('../worker/ai-audit-final.worker.ts', import.meta.url), { type: 'module' });

aiWorker.onmessage = (aiEvent) => {
    const aiData = aiEvent.data;
    if (aiData.type === 'STATUS') { ... }
    else if (aiData.type === 'RESULT') { ... }
};

aiWorker.postMessage({
    type: 'GRADE_SEMANTICS',
    teacherTelemetry: finalReport.teacher_telemetry,
    studentTelemetry: finalReport.student_telemetry,
    idMapping: finalReport.id_mapping
});
```

**Issues:**
1. No timeout for AI worker
2. If AI model fails to load, no recovery
3. AI worker references `idMapping` that might not exist in v3.9 response

---

### 6.2 **Emulator Exports Used But Not Validated**

**Location:** grading-engine.worker.ts line 313+

```typescript
// After dynamic import:
const validator = new emulatorExports.FullCircuitValidator(studentMeta);
```

**Problem:**
- `emulatorExports` could be `{ FullCircuitValidator: undefined }`
- No null check before usage
- Crashes with "Cannot create an instance of undefined"

---

## 7. TELEPORTABLE OBJECTS & WASM BOUNDARY ISSUES

### 7.1 **Binary Key Type Confusion**

**GradingPage.jsx line 303:**
```javascript
let teacherData;
if (teacherKeyCacheRef.current.hash === fileHash && teacherKeyCacheRef.current.key) {
    teacherData = teacherKeyCacheRef.current.key;  // ← What type is this?
} else {
    teacherData = await teacherFile.arrayBuffer();  // ← ArrayBuffer
}
```

**Problem:**
- First time: `teacherData` is `ArrayBuffer`
- After caching: `teacherData` is `Uint8Array` (from `generate_binary_key()` return)
- Worker expects consistent type for `GENERATE_KEY` vs `GRADE`

**In Worker:**
```typescript
if (teacher instanceof ArrayBuffer) {  // ← This check assumes ArrayBuffer
    const teacherMetaJson = wasmExports.extract_project_meta(new Uint8Array(teacher));
} else {
    teacherBinaryKey = new Uint8Array(teacher as any);  // ← Falls back to Uint8Array
}
```

**Issue:** Logic works but is fragile. If cache stores wrong type, extraction fails silently.

---

### 7.2 **Transferable Objects Transfer Rules Violated**

**GradingPage.jsx line 310:**
```javascript
const transferables = [];
if (teacherData instanceof ArrayBuffer) transferables.push(teacherData);
else if (teacherData && teacherData.buffer instanceof ArrayBuffer) transferables.push(teacherData.buffer);

if (studentBuf instanceof ArrayBuffer) transferables.push(studentBuf);

workerRef.current.postMessage({
    type: 'GRADE',
    teacher: teacherData,
    student: studentBuf,
    options
}, transferables);
```

**Problem:**
- If `teacherData` is `Uint8Array`, the buffer is transferred but the Uint8Array reference in UI becomes detached
- Subsequent cache operations on detached `Uint8Array` might fail
- Should deep-clone instead of transferring for cache data

---

## 8. ERROR RECOVERY & CRASH HANDLING

### 8.1 **No Recovery Path for Partial WASM Load Failure**

**Location:** Both workers initEngine()

**Scenario:**
1. WASM blob fails to download (network error)
2. `init(wasmUrl)` silently fails or throws
3. No try-catch around `init()` call
4. Worker crashes

```typescript
async function initEngine() {
    if (isInitialized) return;
    await init(wasmUrl);  // ← No error handling
    init_panic_hook();
    isInitialized = true;
}
```

---

### 8.2 **Silent Failure in captureBehavior Function**

**Location:** Both workers lines 131+

```typescript
catch (err) {
    postMessage({ type: 'LOG', msg: `[v2.3] Warning: ${label} simulation failed: ${err}`, logType: 'warning' });
    return telemetry;  // ← Returns EMPTY telemetry!
}
```

**Problem:**
- If simulation crashes, telemetry is `{ events: [], serial: "", duration_ms: ... }`
- Grading proceeds with empty telemetry → all scores become 0
- UI shows "0% behavioral match" but doesn't know simulation crashed
- No way to distinguish "perfect code" from "compilation error"

---

## 9. PROJECTCOMPILERUTILS PAYLOAD STRUCTURE ISSUES

### 9.1 **Source Code Detection Fragile**

**Location:** grading-worker.ts lines 120-125

```typescript
const sourceCode = compileUnit.mainCode || "";
const isSourceCode = sourceCode.startsWith('#') || 
                     sourceCode.includes('void setup') || 
                     sourceCode.includes('void loop') ||
                     sourceCode.includes('int main');
```

**Problems:**
1. Comments starting with `#` are not C/C++ directives (should be only `#include`, `#define`, etc.)
2. String literals containing "void setup" trigger false positive: `const msg = "void setup() {...}"`
3. No check for Arduino `.ino` syntax (which is C++)

**Better detection:**
```typescript
const hasArduinoMarkers = /\b(void\s+setup|void\s+loop|pinMode|digitalWrite|Serial\.begin)\s*\(/.test(sourceCode);
const hasInclude = sourceCode.includes('#include');
```

---

### 9.2 **File Extension Check Case Sensitivity**

**Location:** projectCompilerUtils.js line 38

```javascript
const allowed = new Set(['.ino', '.h', '.hpp', '.c', '.cpp']);
// ...
.filter((f) => allowed.has(fileExt(f.path)));

export function fileExt(path) {
    const idx = String(path || '').lastIndexOf('.');
    return idx >= 0 ? path.substring(idx).toLowerCase() : '';  // ← Converts to lowercase
}
```

**This is good** - case insensitive [YES]

**But issue:** What if Windows file system has `.INO` (uppercase)?
- `fileExt()` converts to `.ino` [YES]
- File is included [YES]
- Arduino compiler might have issues with uppercase extensions on Linux [WARN]

---

## 10. AI SEMANTIC WORKER INITIALIZATION

### 10.1 **Transformers Library Might Fail to Load**

**Location:** ai-audit-final.worker.ts line 30+

```typescript
async function initTransformers() {
    if (pipeline) return;
    
    const transformers = await import('@xenova/transformers');
    pipeline = transformers.pipeline;
    env = transformers.env;
```

**Problems:**
1. If `@xenova/transformers` is not bundled, import fails
2. No error message guides user to install it
3. AI worker silently dies

---

### 10.2 **WASM Model Path Configuration**

**Location:** ai-audit-final.worker.ts line 41

```typescript
env.backends.onnx.wasm.wasmPaths = '/';  // ← Assumes WASM files at root
env.localModelPath = '/models/';         // ← Assumes models in public/models/
```

**Problem:**
- If app is served from subpath (e.g., `/app/grading`), paths are wrong
- WASM files and models will 404
- No fallback URL resolution

---

## 11. SUMMARY TABLE OF CRITICAL vs HIGH ISSUES

| Issue | Severity | Component | Impact |
|-------|----------|-----------|--------|
| Two competing workers | CRITICAL | Architecture | Engine crash if wrong worker selected |
| WASM init race condition | CRITICAL | Workers | Double initialization, undefined behavior |
| Missing emulatorExports | CRITICAL | v3.9 worker | TypeError when grading |
| PNG metadata decode no error handling | HIGH | SimulatorPage | Silent data loss |
| Silent board discovery fallback | HIGH | projectCompilerUtils | Teacher vs student mismatch |
| No recovery for WASM load failure | HIGH | Workers | Worker crash on network error |
| Empty telemetry on simulation crash | HIGH | Workers | Misleading scores (0% for both success and crash) |
| Key type confusion (ArrayBuffer vs Uint8Array) | MEDIUM | GradingPage | Fragile caching, potential crashes |
| Panic hook not guaranteed | MEDIUM | Workers | Silent crashes in WASM |
| AI worker no timeout | MEDIUM | GradingPage | UI hangs if AI model fails |

---

## 12. RECOMMENDED FIXES (Priority Order)

### IMMEDIATE (Before Next Production Deployment)

1. **Remove v3.9 or make v3.9 compatible**
   - Delete grading-worker.ts OR
   - Make both identical implementations

2. **Fix WASM initialization race**
   - Use Promise serialization
   - Add explicit error handling

3. **Fix emulatorExports undefined**
   - Add null checks before usage
   - Throw clear error if missing

4. **Add PNG metadata decode error handling**
   - Try-catch around JSON.parse
   - Log corruption errors

### SHORT TERM (Next Sprint)

5. Fix silent board discovery
6. Improve source code detection
7. Add recovery for WASM load failures
8. Distinguish simulation crash from success in telemetry

### MEDIUM TERM

9. Refactor to single worker implementation
10. Add comprehensive error recovery in all workers
11. Improve AI worker timeout and fallbacks

---

## 13. EXPECTED FAILURE SCENARIOS

These scenarios WILL crash the engine:

1. **User runs grading twice in quick succession**
   - Race condition in WASM init causes double initialization
   - Panic hooks conflict
   - Worker dies

2. **PNG with UTF-8 metadata encoding issues**
   - Invalid characters in project data
   - Silent JSON parse failure
   - Wrong circuit loaded

3. **Project missing .ino file**
   - `getBoardCompileFiles` picks .h as main
   - Compiler rejects .h syntax
   - Confusing error message

4. **Network latency during WASM load**
   - `await init(wasmUrl)` times out
   - No error propagation
   - Worker hangs silently

5. **Teacher uploaded for board "uno", student uploaded for board "pico"**
   - Silent board discovery fallback
   - Both compiled as different boards
   - Comparison fails with 0% match
   - No warning that boards don't match

---

## FILE LOCATIONS REFERENCE

```
openhw-studio-grading-engine/
├── src/lib.rs                               # Rust grading logic
├── Cargo.toml                               # WASM build config
└── pkg/                                     # Compiled WASM outputs
    ├── openhw_studio_grading_engine.js      # WASM bindings
    └── openhw_studio_grading_engine_bg.wasm # Binary WASM

OpenHW-studio-frontend/
├── src/worker/
│   ├── grading-worker.ts                    # v3.9 (Primary)
│   ├── grading-engine.worker.ts             # v3.9 (Dynamic - PROBLEM)
│   └── ai-audit-final.worker.ts             # AI semantic worker
├── src/wasm/
│   ├── grading/openhw_studio_grading_engine.js
│   └── grading/openhw_studio_grading_engine_bg.wasm
├── src/pages/
│   ├── GradingPage.jsx                      # Main UI coordinator
│   └── simulationpage/
│       ├── SimulatorPage.jsx                # PNG import/export logic
│       └── utils/projectCompilerUtils.js    # Compilation pipeline
└── src/utils/projectCompilerUtils.js        # Source of truth for files
```

---

## CONCLUSION

The auto-grading system has **multiple critical compatibility issues** that can cause silent failures or crashes:

1. **Architecture level:** Two worker implementations competing
2. **Initialization level:** Race conditions in WASM setup
3. **Data pipeline level:** Silent fallbacks and missing error handling
4. **Protocol level:** Message format drift between implementations

**Recommend immediate action on Critical items before any student-facing use.**



