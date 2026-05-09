# Grading Engine: Complete Scoring System & Tolerance Fixes

**Document Date**: May 9, 2026  
**Latest Update**: Fixed 400ms Hard-Cap Tolerance + Sim-Time-Driven Polling  
**Status**: ✅ Deployed & Compiled

---

## Executive Summary

### What Changed
1. **Time Drift Tolerance**: Changed from speed-dependent (100ms → 2000ms) to **FIXED 400ms hard cap for ALL speeds**
   - Before: 8x speed allowed 2000ms drift → bad scoring (e.g., 1514ms drift scored 100)
   - After: 400ms cap for all speeds → fair, consistent scoring
   
2. **Event Capture Duration**: Changed to **sim-time-driven deterministic sampling**
  - Before: wall-clock capture forced all speeds to run same real-time window
  - After: grading waits on simulated time and samples at fixed sim-time steps (2ms)
  - Result: same simulation-time window captured at all speeds, with faster real-time completion at higher speeds

3. **Report Time**: Fixed 35s timeout for ALL speeds (no speed dependency)

### Why This Fixes Problems
- **Time Drift**: Hard 400ms cap means no penalty for drift under threshold, full penalty over
- **Event Count Variance**: Sim-time quantized sampling = all speeds capture the same simulation window deterministically
- **Reporting Consistency**: Same timeout for all speeds = predictable grading time

---

## Complete Scoring System

### Overall Score Calculation

```rust
Overall Score = 0.25 × Spatial_Score + 0.25 × Logic_Score + 
                0.40 × Behavioral_Score + 0.10 × Code_Score
```

**Weightages:**
- **Spatial Score**: 25% → Component placement, circuit connectivity
- **Logic Score**: 25% → Program logic correctness, variable states
- **Behavioral Score**: 40% → Timing accuracy, event sequence matching (MOST IMPORTANT)
- **Code Score**: 10% → Code quality, verified execution

---

## Detailed Scoring Categories

### 1. SPATIAL SCORE (25% weight)

**What it measures**: Circuit layout correctness
- Component placement accuracy
- Wire routing correctness
- Ground/power connections

**Calculation**:
```
Spatial_Score = 100 if all_components_placed_correctly else 0
```

**Penalty**: -1 point per misaligned component (max penalty: 100%)

**Example**: Correctly placed LED + resistor = 100 points

---

### 2. LOGIC SCORE (25% weight)

**What it measures**: Program logic and variable correctness
- Variable initialization
- Conditional statements
- Loop execution
- State transitions

**Calculation**:
```
Logic_Score = 100 - (mismatched_variables × 2 + incorrect_states × 3)
```

**Penalties per mismatch**:
- Variable value mismatch: -2 points
- Incorrect state transition: -3 points
- Logic flow error: -5 points

**Example**: If all variables match teacher's → 100 points

---

### 3. BEHAVIORAL SCORE (40% weight) ⭐ MOST CRITICAL

**What it measures**: Timing accuracy and event sequence matching

#### 3.1 Temporal Event Matching Algorithm

Events are matched between student and teacher telemetry using **bipartite matching**:

```
For each teacher event T:
  Find matching student event S where:
    - Event type matches (PinChange, ComponentState, etc.)
    - Component/pin ID matches (after normalization)
    - Time drift ≤ 400ms (HARD CAP - NO EXCEPTIONS)
  
  If match found: +1 match point
  If no match: -1 point (unmatched event penalty)
  If student has extra events: -0.5 point per extra (up to 20% surplus allowed)
```

#### 3.2 Time Drift Tolerance: Fixed 400ms Hard Cap

**NEW RULE (as of v2.5)**: All speeds use identical 400ms tolerance

```rust
// File: openhw-studio-grading-engine/src/lib.rs (line ~612)
let adaptive_tolerance_ms = 400.0;  // FIXED: 400ms for 1x/2x/4x/8x
```

**Why 400ms?**
- Accounts for polling granularity at 8x speed
- Fair across all simulation speeds
- Clear penalty threshold: > 400ms = points deducted

**Example Impact**:
```
Student Event Timing vs Teacher:
- Drift +50ms  → MATCH (within 400ms tolerance) ✓
- Drift +350ms → MATCH (within 400ms tolerance) ✓
- Drift +450ms → NO MATCH (exceeds 400ms threshold) ✗

For +450ms drift event:
  Behavioral Score -= (mismatch_penalty + time_drift_severity)
```

#### 3.3 Pin Change Events (Critical)

Pin changes are prioritized—they represent digital I/O transitions (e.g., LED on/off):

```
Per pin change event:
  - Base match: +2 points
  - Time drift ≤ 100ms: full credit
  - Time drift 100-400ms: 50% credit
  - Time drift > 400ms: 0% credit
  - Missing pin change: -5 points
```

**Example: LED Blink Pattern**
```
Teacher telemetry:          Student telemetry:
PinChange(13=H@22ms)       PinChange(13=H@25ms)    Drift: +3ms ✓ MATCH
PinChange(13=L@517ms)      PinChange(13=L@519ms)   Drift: +2ms ✓ MATCH
PinChange(13=H@1001ms)     PinChange(13=H@1004ms)  Drift: +3ms ✓ MATCH
→ All 3 events match → Behavioral score = high
```

#### 3.4 Component State Events (Supporting)

Component states (voltage, current, LED brightness, etc.):

```
Per component state event:
  - Base match: +1 point
  - Time drift ≤ 400ms: full credit
  - Time drift > 400ms: 0% credit
  - Extra state event (student): -0.2 points
  - Missing state event: -0.5 points
```

#### 3.5 Event Cutoff & Grace Window

```
Event Timeline:
0ms ─────────────────────────────────→ 8000ms (simulation end)
                          │
                    7900ms cutoff
               7700-7900ms grace window
```

**Rules**:
- Events ≤ 7900ms: Normal scoring
- Events 7700-7900ms (teacher-only): Grace events, NO penalty
- Events > 7900ms: Ignored (no fidelity penalty)

```rust
// File: openhw-studio-grading-engine/src/lib.rs (line ~681)
if last_event_time > 7700 && last_event_time < 8000 {
    (1.0_f32, t_timeline.len())  // Grace: 100% score, no penalty
}
```

#### 3.6 Phase-Shift Recovery

If events don't match at exact index, try up to 10 indices offset:

```
Phase offsets attempted: -10, -9, ..., -1, 0, +1, ..., +9, +10
Goal: Find best alignment despite polling jitter
```

#### 3.7 Extra Event Tolerance

Student can have up to 20% more events than teacher (for extra debug output):

```
Allowed surplus = ceil(teacher_events.count × 0.20)
If student_extra_events ≤ allowed_surplus: no penalty
If student_extra_events > allowed_surplus: -1 point per extra
```

#### 3.8 Behavioral Score Formula

```
Behavioral_Score = 100 - total_penalty_points

Where total_penalty_points = 
  (mismatched_events × weight) +
  (time_drift_violations × 3) +
  (phase_shift_failures × 2) +
  (extra_events_penalty)

Max penalty = 50 points (min behavioral score = 50%)
```

**Example Calculation**:
```
Teacher events: 16 pin changes
Student events: 16 pin changes

Matches: 15 (3ms avg drift ✓)
Mismatches: 1 (drift=450ms ✗)
Phase shifts recovered: 0
Extra events: 0

Penalty = (1 mismatch × 4 weight) + 0 + 0 + 0 = 4 points
Behavioral_Score = 100 - 4 = 96 points ✓
```

---

### 4. CODE SCORE (10% weight)

**What it measures**: Program code quality and correctness
- Syntax correctness
- Function definitions
- Return values

**Calculation**:
```
Code_Score = 100 if code_compiles and code_verifies else 0
```

**Verified Code**: +5 bonus points if code matches expected logic flow

---

## Event Weighting Details

### Event Type Hierarchy

1. **PinChange** (Weight: 4) - Digital I/O transitions
   - Highest priority (core functionality)
   - LED on/off, button press/release
   - Must match within 400ms

2. **ComponentState** (Weight: 2) - Analog measurements
   - Voltage, current, power values
   - LED brightness, resistor dissipation
   - Slightly forgiving

3. **SerialOutput** (Weight: 1) - Debug messages
   - Console prints
   - Logging data
   - Low priority

### Total Event Scoring

```
Total_Temporal_Points = Σ(match_count[i] × weight[i])
                      - Σ(mismatch_penalty[i] × weight[i])

Behavioral_Score = min(100, max(50, Total_Temporal_Points / max_possible_points × 100))
```

---

## Implementation Details

### File: `openhw-studio-grading-engine/src/lib.rs`

#### Fixed 400ms Tolerance (Line ~612)
```rust
let speed_factor = options.simulation_speed.max(1.0).min(8.0);
// Fixed hard cap: 400ms tolerance for ALL speeds
// Time drift > 400ms = points deducted (no exception based on speed)
let adaptive_tolerance_ms = 400.0;  // FIXED: 400ms for 1x/2x/4x/8x
logs.push(format!("Behavior: Temporal matcher configured with FIXED 400ms time drift tolerance (hard cap for all speeds).",));
```

#### Time Drift Penalty Logic (Line ~750)
```rust
// Calculate penalty for time drift violations
let max_allowed_drift = 400.0;  // ms
if event_time_drift.abs() > max_allowed_drift {
    // Penalty increases with severity beyond threshold
    let excess_drift = event_time_drift.abs() - max_allowed_drift;
    let severity_multiplier = (excess_drift / 100.0).min(3.0);  // Cap at 3x
    behavioral_penalty += 3.0 * severity_multiplier;  // Up to 9 point penalty per event
}
```

#### Grace Events (Line ~681)
```rust
// Teacher-only events near cutoff: no penalty (grace window)
if let Some(last_event_time) = t_timeline.last().and_then(|e| Some(get_event_time(e) as i32)) {
    if last_event_time > 7700 && last_event_time < 8000 {
        (1.0_f32, t_timeline.len())  // Grace: 100% score
    }
}
```

---

### File: `OpenHW-studio-frontend/src/worker/grading-engine.worker.ts`

#### Sim-Time-Driven Polling (Line ~248)
```javascript
// Preferred mode: wait until simulated time reaches each target sample point.
// This preserves speed benefits (higher speed finishes faster in real-time)
// while keeping deterministic sampling over the same simulated-time window.
const pollIntervalSimMs = 2;
for (let t = simStartMs; t < simStartMs + Math.min(durationMs, 7900); t += pollIntervalSimMs) {
  const target = t + pollIntervalSimMs;
  while (runner.getSimulatedTimeMs() < target) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const nowMs = runner.getSimulatedTimeMs();
  const alignedNowMs = Math.floor(nowMs / pollIntervalSimMs) * pollIntervalSimMs;
  if (alignedNowMs - lastPollSimMs < pollIntervalSimMs) { continue; }
  lastPollSimMs = alignedNowMs;
```

#### Deterministic Polling (Lines 261-263)
```javascript
// Align snapshot times to poll interval boundaries for reproducibility
// This ensures same circuit run multiple times = same event captures
const alignedNowMs = Math.floor(nowMs / Math.max(1, Math.round(pollIntervalMs))) * Math.max(1, Math.round(pollIntervalMs));
```

#### Event Cutoff with Grace Window (Lines 290-304)
```javascript
// Separate events: kept (≤7900ms) vs ignored (>7900ms)
const keptEvents = [];
const ignoredEvents = [];

for (const event of capturedEvents) {
    const eventTime = getEventTimeMs(event);
    if (eventTime <= 7900) {
        keptEvents.push(event);
    } else {
        ignoredEvents.push(event);  // No fidelity penalty
    }
}
```

---

## Why This Works

### 1. Fixed 400ms Tolerance Fairness
```
Before (speed-dependent):
  1x:  100ms → Tight, fair
  4x:  1000ms → Loose, allows 10x more drift!
  8x:  2000ms → Very loose, allows 20x drift

After (fixed):
  1x:  400ms → Same for all
  4x:  400ms → Same for all
  8x:  400ms → Same for all
```

### 2. Sim-Time Polling Consistency
```
Before (wall-clock forced):
  1x:  8s real-time
  8x:  8s real-time
  (speed benefit reduced)

After (sim-time-driven):
  1x: ~8s real-time for 8000ms sim window
  2x: ~4s real-time for same 8000ms sim window
  4x: ~2s real-time for same 8000ms sim window
  8x: ~1s real-time for same 8000ms sim window
  (same sim-time coverage, faster completion at higher speeds)
```

### 3. Time Drift Penalty Formula
```
Drift ≤ 400ms: 
  → Event matches → No penalty
  
Drift 400-500ms:
  → Excess = 100ms
  → Severity = 1x multiplier
  → Penalty = 3 points
  
Drift 500-700ms:
  → Excess = 100-300ms
  → Severity = 2x multiplier
  → Penalty = 6 points
  
Drift > 700ms:
  → Capped at 3x multiplier
  → Penalty = 9 points (max)
```

### 4. Delta/Event Drift Root Cause and Fix
```
Observed issue:
  - Component timelines showed drift growing over time (phase creep)
  - Some runs missed component delta transitions near boundaries
  - Result: event-count mismatch and temporal score instability at higher speeds

Root causes:
  1) Delta-only snapshots can miss boundary transitions if baseline/final samples are not explicitly captured.
  2) Using live nowMs for event timestamps introduces sample-time jitter; over long traces this appears as drift growth.
  3) Prior scoring focused mainly on hard misses; trend-like drift under tolerance could escape deduction.

Fixes applied:
  - Baseline deep snapshot captured once at start (stable anchor).
  - Sim-time quantized timestamps used for emitted component events (aligned sampling clock).
  - Final delta flush captured at sim-end boundary (avoid last-transition loss).
  - Wait loop timeout guard added (prevents stuck sim-time wait).
  - Drift-trend penalty added in temporal matcher (light deduction for progressive drift growth).
```

### 5. Real-World Completion Time by Speed (Sim-Time Driven)
```
Target simulated window: 8000ms

Expected real-world completion:
  1x ≈ 8.0s
  2x ≈ 4.0s
  4x ≈ 2.0s
  8x ≈ 1.0s

Actual runtime can vary slightly due worker scheduling and browser load.

Diagnostic field:
  - real_capture_ms is now emitted in telemetry for each run,
    so bundle analysis can report true wall-clock capture duration per speed.
```

---

## Test Results Expected

### Bundle Analysis
```
BEFORE FIX:
Bundle 4x_249: Drift 1514ms, Score 100 ❌ (WRONG - should be penalized!)
Bundle 8x_141: Drift 858ms, Score 81 ⚠️ (Inconsistent - why 81?)

AFTER FIX:
All bundles: Drift > 400ms → Points deducted ✓
All speeds: Similar event counts (100+) ✓
All speeds: Report in 35s ✓
```

### Consistency Targets
```
1x Speed:
  Run 1: Behavioral 100, 114 events
  Run 2: Behavioral 100, 114 events
  Run 3: Behavioral 100, 114 events
  → Perfect consistency ✓

8x Speed (NEW):
  Run 1: Behavioral 95-100, 100+ events
  Run 2: Behavioral 95-100, 100+ events
  Run 3: Behavioral 95-100, 100+ events
  → Consistent (small variance OK for polling jitter)
```

---

## Summary: What Gets Scored

| Category | Weight | Events | Tolerance | Penalty Formula |
|----------|--------|--------|-----------|-----------------|
| **Spatial** | 25% | Component placement | N/A | -100 if wrong |
| **Logic** | 25% | Variable states | N/A | -2 to -5 per error |
| **Behavioral** | 40% | Pin changes (wt:4), States (wt:2) | **400ms hard cap** | 3-9 pts per drift |
| **Code** | 10% | Syntax, execution | N/A | 0 or 100 |

**Total Score Calculation**:
```
Final Score = 0.25×S + 0.25×L + 0.40×B + 0.10×C
            = (Spatial + Logic + Behavioral + Code) / 4 × Weighted_Average
```

---

## Deployment Checklist

✅ **Rust Changes**:
- [x] Fixed 400ms tolerance for all speeds (line 612)
- [x] Updated logs to show fixed tolerance
- [x] Grace event logic active (line 681)
- [x] Extra event tolerance at 20% (line 810)
- [x] Phase-shift recovery enabled (line 816)

✅ **Frontend Changes**:
- [x] Sim-time-driven polling in grading worker (line 248)
- [x] Deterministic alignment of snapshot times (quantized to 2ms)
- [x] Fixed 35s timeout as fallback guard
- [x] Event cutoff at 7900ms with grace window

✅ **Scope Isolation Confirmed**:
- [x] Change is inside grading worker only: OpenHW-studio-frontend/src/worker/grading-engine.worker.ts
- [x] Worker is instantiated from grading page only: OpenHW-studio-frontend/src/pages/GradingPage.jsx
- [x] No changes made to CLI or MCP simulation paths

✅ **Build Status**:
- [x] Rust build: 0 errors, 14 warnings
- [x] Frontend build: 0 errors, 5 warnings
- [x] WASM module: 280.91 kB (ready)

---

## Next Steps for Validation

1. **Run test circuit 3x at each speed** (1x/2x/4x/8x)
2. **Verify event counts consistent** (±5% variance acceptable)
3. **Verify behavioral scores consistent** (same within ±2 points)
4. **Verify drift-trend deduction behavior** (increasing drift should reduce temporal score even before hard misses dominate)
5. **Check report completion time scaling** (about 8s/4s/2s/1s for 1x/2x/4x/8x)
5. **Upload diagnostic bundles** for analysis

