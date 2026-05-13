# Grading Engine v2.5: Quick Reference Card

**TL;DR Version - Print this!**

---

## The Three Problems & Solutions

### Problem 1: Unfair Time Drift Tolerance [FAIL]

```
BEFORE (v2.4):
  1x allowed:  100ms   ← Strict
  4x allowed:  1000ms  ← 10x looser!
  8x allowed:  2000ms  ← 20x looser than 1x!
  
  Result: 1514ms drift → Score 100 [NO] (WRONG!)

AFTER (v2.5):
  1x allowed:  400ms   ← Fair
  2x allowed:  400ms   ← Fair
  4x allowed:  400ms   ← Fair
  8x allowed:  400ms   ← Fair
  
  Result: 1514ms drift → Score ~91 [YES] (CORRECT!)
```

---

### Problem 2: Event Capture Variance [FAIL]

```
BEFORE (v2.4):
  Polling based on: Simulation time
  
  1x speed:  8000ms sim-time = 8s real-time  = 114 events
  8x speed:  8000ms sim-time = 1s real-time  = 31-37 events (66% FEWER!)

AFTER (v2.5):
  Polling based on: Wall-clock time
  
  1x speed:  8s real-time = 8000ms sim-time   = 100+ events [YES]
  8x speed:  8s real-time = 64000ms sim-time  = 150+ events [YES]
```

---

### Problem 3: Inconsistent Report Times [FAIL]

```
BEFORE (v2.4):
  1x speed:  ~8s real-time
  8x speed:  ~1s real-time
  
  Result: Report times vary by 8x (confusing!)

AFTER (v2.5):
  1x speed:  ~35s (fixed)
  8x speed:  ~35s (fixed)
  
  Result: Predictable, consistent reporting [YES]
```

---

## Four Key Changes

### Change 1: Fixed 400ms Tolerance

**File**: `lib.rs` (line 612)

```rust
// Was: Speed-dependent (100ms → 2000ms)
let adaptive_tolerance_ms = match speed_factor { 1.0 => 100, 2.0 => 300, ... _ => 2000 };

// Now: Fixed for all speeds
let adaptive_tolerance_ms = 400.0;
```

**Impact**: Same scoring fairness across 1x/2x/4x/8x

---

### Change 2: Wall-Clock Polling

**File**: `grading-engine.worker.ts` (line 248)

```javascript
// Was: while (simulationTime < 8000ms)  ← 8x faster sim = 8x fewer events
// Now: while (wallClockTime < 8000ms)   ← Same real-time for all

const wallClockStart = Date.now();
while (Date.now() - wallClockStart < 8000) {
    // Poll more frequently at high speeds
}
```

**Impact**: Consistent event capture regardless of speed

---

### Change 3: Deterministic Alignment

**File**: `grading-engine.worker.ts` (line 261)

```javascript
// Was: lastPollSimMs = nowMs;  ← Can jitter ±1-2ms each run
// Now: lastPollSimMs = Math.floor(nowMs / pollInterval) * pollInterval;  ← Quantized

const alignedNowMs = Math.floor(nowMs / pollIntervalMs) * pollIntervalMs;
```

**Impact**: Same circuit → same events every run (deterministic)

---

### Change 4: Fixed 35s Timeout

**File**: `grading-engine.worker.ts` (line 295)

```javascript
// Was: const wallTimeoutMs = Math.max(30000, Math.ceil(30000 / normalizedSpeed));
// Now: const wallTimeoutMs = 35000;  ← Same for all speeds
```

**Impact**: Report time predictable (~35s all speeds)

---

## Scoring Formula (Remember This!)

```
OVERALL SCORE = 0.25×Spatial + 0.25×Logic + 0.40×Behavioral + 0.10×Code

Behavioral Score (40% weight) = 100 - Penalties

Penalties:
  Drift > 400ms:        -3 to -9 points (fixed threshold)
  Unmatched event:      -4 to -8 points
  Missing pin change:   -5 points
  Extra events (20%+):  -1 point each

Min possible: 50 (hard floor prevents cascade failure)
```

---

## Time Drift Penalty Table

| Drift | Penalty | Outcome |
|-------|---------|---------|
| 0-400ms | 0 | Event matches [YES] |
| 400-500ms | -3 pts | Mild violation |
| 500-600ms | -6 pts | Moderate violation |
| 600ms+ | -9 pts | Severe violation (capped) |

---

## Event Type Weights

| Event Type | Weight | Example |
|-----------|--------|---------|
| PinChange | 4 | GPIO going HIGH/LOW |
| ComponentState | 2 | LED voltage/current |
| SerialOutput | 1 | Debug print |

---

## Expected Results After v2.5

### Before (v2.4):
```
1x speed:  Behavioral 100, 114 events, ~8s
2x speed:  Behavioral 100, 114 events, ~4s
4x speed:  Behavioral 100, 108 events, ~2s
8x speed:  Behavioral 76-81, 31-37 events, ~1s  [NO] (broken!)
```

### After (v2.5):
```
1x speed:  Behavioral 100, 100+ events, ~35s
2x speed:  Behavioral 100, 110+ events, ~35s
4x speed:  Behavioral 100, 130+ events, ~35s
8x speed:  Behavioral 95+, 150+ events, ~35s   [YES] (fixed!)
```

---

## Logs to Look For

### v2.5 Logs Should Include:

```
[YES] "[1x/2x/4x/8x] Behavior: Temporal matcher configured with FIXED 400ms time drift tolerance"
[YES] "[1x/2x/4x/8x] Behavior: Telemetry diffing complete. Score: X"
[YES] "[1x/2x/4x/8x] Scoring Breakdown: Spatial: X, Logic: Y, Behavior: Z, Code: W"
```

### v2.4 Logs (OLD, DO NOT USE):

```
[NO] "[8x] Behavior: Temporal matcher configured with adaptive tolerance 2000ms"
```

---

## Validation Checklist

### Quick Test (Do This):

```
1. Run LED blink circuit at 1x speed 3 times
   Expected: Behavioral 100, ±0-2 pts variance

2. Run same circuit at 8x speed 3 times
   Expected: Behavioral 95+, ±2-3 pts variance

3. Check event counts:
   Expected: 8x captures ~50% more events than 1x

4. Check report times:
   Expected: All ~35 seconds (±5s acceptable)
```

---

## Troubleshooting

### Score Too Low?

```
Check 1: Behavioral score low (< 80)?
  → Check time drift in report
  → If drift > 400ms → penalty is CORRECT

Check 2: Event count very different between runs?
  → Check logs for "FIXED 400ms" message
  → If missing → you're still on v2.4

Check 3: Report time > 45 seconds?
  → Check for emulator crashes/slowdowns
  → Normal should be ~35s ±5s
```

### Score Seems Unfair?

```
1. Extract the grading report from bundle
2. Check "temporal_breakdown" section
3. Look for events with drift > 400ms
4. Those SHOULD be marked as penalized
5. If they're not, something's wrong → report it!
```

---

## Files Changed

| File | Lines | Change | Purpose |
|------|-------|--------|---------|
| `lib.rs` | 612 | Fixed 400ms tolerance | Fair scoring |
| `grading-engine.worker.ts` | 248 | Wall-clock polling | Consistent capture |
| `grading-engine.worker.ts` | 261 | Deterministic alignment | Reproducibility |
| `grading-engine.worker.ts` | 295 | Fixed 35s timeout | Predictable timing |

---

## Build Status

```
[OK] Rust:     0 errors, 14 warnings
[OK] Frontend: 0 errors, 5 warnings (unrelated)
[OK] WASM:     280.91 kB (ready)
[OK] Deploy:   Ready for production
```

---

## Key Metrics

```
Improvement areas:

1. Time Drift Fairness:
   Before: 2000ms allowed at 8x (unfair)
   After:  400ms for all speeds (fair)
   → All speed behavior now consistent [YES]

2. Event Capture:
   Before: 8x captured 31-37 events (too few)
   After:  8x captures 150+ events (5x improvement)
   → Better behavior matching [YES]

3. Determinism:
   Before: Same circuit, different results each run
   After:  Same circuit, identical results ±2pts
   → Reproducible grading [YES]

4. Report Time:
   Before: 1s-8s (varies by speed)
   After:  ~35s (consistent)
   → Predictable user experience [YES]
```

---

## Remember

```
400ms = THE MAGIC NUMBER in v2.5

Drift under 400ms:    [YES] Perfect match (no penalty)
Drift over 400ms:     [NO] Penalty applied (3-9 points)

This applies to ALL speeds equally.
No more unfair tolerance scaling!
```

---

## Questions?

**See full documentation:**
- `SCORING_SYSTEM_AND_TOLERANCE_FIX.md` - Complete theory
- `IMPLEMENTATION_GUIDE_V2_5.md` - Code changes
- `COMPLETE_SCORING_CALCULATION_GUIDE.md` - Examples
- `GRADING_ENGINE_V2_5_STATUS.md` - Deployment status



