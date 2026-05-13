# AUTO-GRADING SYSTEM ARCHITECTURE & ISSUES MAP

## CURRENT ARCHITECTURE FLOW

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          GradingPage.jsx (UI)                           │
│  - Uploads teacher & student PNG files                                  │
│  - Spawns GradingWorker (v3.9 - grading-engine.worker.ts)              │
│  - Spawns AI-Audit Worker for semantic validation                      │
│  - Displays results with teacher/behavioral/AI scores                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│           GradingWorker (v3.9 - grading-engine.worker.ts)              │
│                                                                          │
│  Problem #1: Polyfills for window/document (unnecessary)               │
│  Problem #2: Dynamic imports with no null checking                     │
│                                                                          │
│  ┌─ initEngine()                                                        │
│  │  ├─ Load WASM: openhw_studio_grading_engine.js                     │
│  │  ├─ Dynamic import: @openhw/emulator                               │
│  │  └─ init_panic_hook()                                              │
│  │  [ISSUE: Race condition if called twice]                           │
│  │                                                                      │
│  ├─ PNG Input (ArrayBuffer)                                            │
│  │  └─ extract_project_meta(Uint8Array)  [WASM call]                 │
│  │     └─ Returns JSON project metadata                               │
│  │                                                                      │
│  ├─ Validation Engine (FullCircuitValidator)                          │
│  │  └─ Electrical safety checks                                       │
│  │  └─ Code-hardware sync analysis                                    │
│  │  [ISSUE: emulatorExports might be undefined]                      │
│  │                                                                      │
│  ├─ Simulation (captureBehavior)                                       │
│  │  ├─ Detect if source code or HEX                                   │
│  │  ├─ [ISSUE: Fragile source detection]                             │
│  │  ├─ If source: compile via localhost:5001/api/compile             │
│  │  ├─ Create runner, run simulation for 8000ms                       │
│  │  ├─ Capture pin changes, serial output, component states          │
│  │  └─ Return telemetry object                                        │
│  │  [ISSUE: Silent failure returns empty telemetry]                  │
│  │                                                                      │
│  └─ Grading (grade_circuits_wasm)  [WASM call]                        │
│     ├─ Compare spatial layout (component positions)                   │
│     ├─ Compare logic (wiring connections)                            │
│     ├─ Compare behavior (pin changes, serial output)                 │
│     ├─ Compare code (if available)                                    │
│     └─ Return: { spatial_score, logic_score, behavioral_score, ... } │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
                 [Problem: Orphaned v3.9 worker never used]
                    [Problem: Message format drift]
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  GradingPage receives GRADING_COMPLETE message                         │
│  - If has teacher_telemetry & student_telemetry:                     │
│    Spawn AI-Audit Worker for semantic validation                      │
│                                                                          │
│  AI-Audit-Final.worker.ts                                              │
│  ├─ Load @xenova/transformers library                                 │
│  ├─ Load all-MiniLM-L6-v2 model (23MB)                               │
│  ├─ Flatten telemetry to functional + electrical traces               │
│  ├─ Generate embeddings (85% functional, 15% electrical)              │
│  ├─ Calculate cosine similarity                                        │
│  └─ Return AI score                                                    │
│  [ISSUE: No timeout, model load can fail silently]                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│               Final Grade Calculation (GradingPage.jsx)                │
│  weighted_score = (spatial*20 + logic*30 + behavioral*40 + code*10)/100│
│  If AI score exists: verified_behavior = (behavioral + ai_score) / 2  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## PNG IMPORT/EXPORT PIPELINE

```
EXPORT: SimulatorPage.jsx (downloadPng)
┌─────────────────────────────────────────┐
│ 1. Render circuit to canvas via html2canvas (120KB lazy-load)         │
│ 2. Calculate bounding box (components + wires + pins)                 │
│ 3. Encode canvas to PNG blob                                           │
│ 4. Append metadata: "\x00OPENHW_META\x00" + JSON                      │
│    - Board type, components, wires, code, files, etc.                 │
│ 5. Save combined PNG file                                              │
│ 6. Cache result by render signature (10 min TTL)                      │
└─────────────────────────────────────────┘

IMPORT: SimulatorPage.jsx (importPng)
┌─────────────────────────────────────────┐
│ 1. Read PNG as Uint8Array                                              │
│ [ISSUE: No error handling for file read]                              │
│ 2. Search for marker "\x00OPENHW_META\x00" from end backwards        │
│ 3. Extract bytes after marker                                          │
│ [ISSUE: UTF-8 decode with fatal: false, no error check]               │
│ 4. JSON.parse() metadata                                               │
│ 5. Call applyImportedProjectMeta()                                    │
│    - Update components, wires, code, projectFiles                     │
│ 6. Refresh canvas                                                      │
└─────────────────────────────────────────┘
```

---

## COMPILATION PIPELINE (projectCompilerUtils.js)

```
normalizeProjectFiles(files)
├─ Deduplicate by path/id
├─ Remove null entries
└─ Return normalized array

getBoardCompileFiles(project, boardId)
├─ Filter: Only .ino, .h, .hpp, .c, .cpp files
├─ Discovery: Find files for requested boardId
│  [ISSUE: Silent fallback if board not found]
├─ Find main file:
│   ├─ Preferred: {boardId}.ino
│   ├─ Fallback: Any .ino file
│   ├─ Fallback: First file in list
│   [ISSUE: Can pick .h file as main, compiler fails]
├─ Collect supporting files
├─ Build compilation unit:
│   ├─ mainCode (from main file or component attrs.code)
│   ├─ sketchName (board id)
│   ├─ files (array of supporting files)
│   └─ hasMainFile (boolean)
└─ Return compilation unit

Workers use: getBoardCompileFiles(meta, boardCompId)
│
└─ Send to localhost:5001/api/compile
   ├─ Input: { code, files, sketchName, board: fqbn }
   ├─ Output: { hex: "a1b2c3...", ... }
   └─ On error: Throw with diagnostics
```

---

## IDENTIFIED ISSUES BY COMPONENT

### WORKERS INITIALIZATION

```
v3.9 (grading-worker.ts)          v3.9 (grading-engine.worker.ts)
├─ Direct imports                  ├─ Polyfills window/document
├─ import { init, ... }            ├─ import('../wasm/...')
├─ Immediate fail if missing       ├─ Lazy load, silent fail
├─ FullCircuitValidator direct     ├─ emulatorExports.FullCircuitValidator
└─ Orphaned (not used)             └─ ACTIVE but fragile

RACE CONDITION (Both versions):
┌─────────────────────────────────────┐
│ Message 1: GRADE → initEngine()    │
│ (isInitialized = false)             │
│   await init(wasmUrl) [starting]   │
│                                     │
│ Message 2: GRADE → initEngine()    │
│ (isInitialized still false!)        │
│   await init(wasmUrl) [starting]   │
│                                     │
│ Result: Double init, conflicting    │
│ panic hooks, UNDEFINED BEHAVIOR     │
└─────────────────────────────────────┘
```

---

### COMPILATION PIPELINE ISSUES

```
Issue #1: Silent Board Fallback
┌──────────────────────────────┐
│ Teacher board: "uno"         │
│ Student board: "pico"        │
│                              │
│ projectCompilerUtils sees no │
│ "pico" files, silently uses  │
│ first board found (probably  │
│ "uno" from teacher)          │
│                              │
│ Result: Both compiled as uno │
│ → Perfect match (false)      │
│ No warning!                  │
└──────────────────────────────┘

Issue #2: Main File Wrong Type
┌──────────────────────────────┐
│ Project has:                 │
│ - board.h (header)           │
│ - board.cpp (implementation) │
│ - NO board.ino              │
│                              │
│ getBoardCompileFiles picks:  │
│ mainCode = board.h           │
│                              │
│ Arduino compiler expects:    │
│ mainCode = board.ino (or .c) │
│                              │
│ Result: Compilation fails    │
│ Confusing error messages     │
└──────────────────────────────┘

Issue #3: Source Detection Fragile
┌──────────────────────────────┐
│ sourceCode.includes('void setup')
│                              │
│ Matches:                     │
│ [YES] "void setup() { }"        │
│ [YES] "// void setup manual"    │
│ [NO] const x = "void setup()"; │
│                              │
│ False positives in strings   │
└──────────────────────────────┘
```

---

### PNG METADATA ISSUES

```
Export Flow
┌─────────────────────────────────────────┐
│ HTML canvas → png blob                  │
│ (html2canvas renders DOM) [YES]             │
│                                          │
│ PNG bytes + metadata bytes → combined   │
│ new Uint8Array(pngLen + metaLen)       │
│                                          │
│ Issue: Cache stored as Uint8Array       │
│ Next use: Passed to worker as Uint8Array│
│ Worker checks: instanceof ArrayBuffer   │
│ Fails: Type mismatch                    │
└─────────────────────────────────────────┘

Import Flow
┌─────────────────────────────────────────┐
│ Search for marker from end              │
│ [YES] Correctly handles large metadata     │
│                                          │
│ Extract bytes after marker              │
│ TextDecoder('utf-8', {fatal: false})   │
│ [NO] Silent replacement of invalid UTF-8 │
│                                          │
│ JSON.parse(jsonStr)                     │
│ [NO] No try-catch, silent failure         │
│                                          │
│ Result: Wrong project loaded, no error │
└─────────────────────────────────────────┘
```

---

### TELEMETRY CAPTURE ISSUES

```
captureBehavior() Function
┌─────────────────────────────────────────┐
│ 1. Detect source vs HEX                 │
│    [Fragile regex check]                │
│                                          │
│ 2. If source, compile via backend      │
│    [No timeout specified]               │
│    [No retry logic]                     │
│                                          │
│ 3. Create runner, run simulation       │
│    for 8000ms                           │
│                                          │
│ 4. Capture:                             │
│    - PIN CHANGES                        │
│    - COMPONENT STATE CHANGES            │
│    - SERIAL OUTPUT                      │
│                                          │
│ 5. Error: catch (err) {                │
│    postMessage(warning log)            │
│    return telemetry  // EMPTY!         │
│ }                                       │
│                                          │
│ Issue: Crashed simulation = no events   │
│ Result: 0% behavioral match             │
│ But also 0% for correct code!           │
│ Can't distinguish crash from success   │
└─────────────────────────────────────────┘
```

---

### AI SEMANTIC WORKER

```
Initialization
├─ Load @xenova/transformers
│  └─ [ISSUE: Package might not be bundled]
├─ Initialize ONNX backends (1 thread)
├─ Set WASM path: "/" and model path: "/models/"
│  └─ [ISSUE: Assumes root-level paths, fails in subpaths]
└─ Load all-MiniLM-L6-v2 model (23MB)
   └─ [ISSUE: No timeout, can hang indefinitely]

Processing
├─ Flatten telemetry to semantic traces
├─ Generate embeddings (functional 85%, electrical 15%)
├─ Calculate cosine similarity
└─ Return score

Issues
├─ GradingPage spawns AI worker but no timeout
├─ If model fails to load, UI waits forever
├─ No fallback if @xenova/transformers missing
└─ Cache not persistent across sessions
```

---

## EXPECTED CRASH SCENARIOS

```
SCENARIO 1: Rapid Grade Submission
User clicks "Grade" → Worker starts init
User clicks "Grade" again before first completes
  ↓
Both messages trigger initEngine()
  ↓
Both call: await init(wasmUrl)
  ↓
Double initialization conflict
  ↓
CRASH: isInitialized not synchronized

SCENARIO 2: Invalid PNG Metadata
User uploads PNG with corrupted metadata bytes
  ↓
TextDecoder succeeds (fatal: false)
  ↓
JSON.parse() fails silently (no try-catch)
  ↓
Wrong project metadata used
  ↓
SILENT DATA LOSS: Wrong circuit graded

SCENARIO 3: Simulation Crash During Behavior Capture
Simulation has infinite loop or memory error
  ↓
captureBehavior() catch block triggered
  ↓
return telemetry { events: [] }
  ↓
grade_circuits_wasm gets empty telemetry
  ↓
Returns: behavioral_score: 0%
  ↓
MISLEADING RESULT: Can't distinguish crash from correct behavior

SCENARIO 4: Board Mismatch
Teacher PNG exported from "uno" circuit
Student PNG exported from "pico" circuit
User grades them
  ↓
extract_project_meta() gets student PNG
  ↓
getBoardCompileFiles() looks for "pico" files
  ↓
No "pico" files found (only "uno" from teacher)
  ↓
Silent fallback: uses first board ("uno")
  ↓
Both graded on "uno" circuit
  ↓
Perfect match (0% difference)
  ↓
NO WARNING: User doesn't know boards were mismatched

SCENARIO 5: WASM Network Timeout
User runs grading with slow network
  ↓
initEngine(): await init(wasmUrl)
  ↓
Network stall, timeout after 30s
  ↓
No error thrown (no try-catch)
  ↓
Worker state: partially initialized
  ↓
Next function call: extract_project_meta(...)
  ↓
CRASH: Function doesn't exist (WASM not loaded)
```

---

## SUMMARY OF INCOMPATIBILITIES

| Layer | Issue | Severity | Fix Effort |
|-------|-------|----------|-----------|
| **Architecture** | Two worker implementations | CRITICAL | HIGH |
| **Initialization** | WASM race condition | CRITICAL | MEDIUM |
| **Initialization** | Missing emulatorExports check | CRITICAL | LOW |
| **Data Pipeline** | PNG decode no error handling | HIGH | LOW |
| **Data Pipeline** | Silent board fallback | HIGH | MEDIUM |
| **Compilation** | Wrong main file selection | HIGH | LOW |
| **Telemetry** | Empty on simulation crash | HIGH | MEDIUM |
| **Caching** | ArrayBuffer/Uint8Array type mismatch | MEDIUM | LOW |
| **Panic Handling** | Hook not guaranteed | MEDIUM | LOW |
| **AI Worker** | No timeout, can hang | MEDIUM | LOW |

---

## VERIFICATION CHECKLIST

```
[ ] Can run same grading job twice without crash?
[ ] PNG import handles corrupted metadata gracefully?
[ ] Board mismatch is detected and warned?
[ ] Simulation crash produces meaningful error?
[ ] Compilation errors show clear messages?
[ ] AI worker completes or times out?
[ ] Can cache and reuse teacher key?
[ ] Different WASM initialization paths work?
[ ] Serial output correctly captured?
[ ] Pin state changes tracked accurately?
```



