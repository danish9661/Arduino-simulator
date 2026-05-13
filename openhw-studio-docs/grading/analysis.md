# Grading Engine: Analysis, Issues, and Solutions

## Executive Summary

Three diagnostic bundles reveal critical insights into temporal matching, event capture, and time-drift handling:

| Metric | Bundle 1 (4x) | Bundle 2 (8x) | Bundle 3 (1x) |
|--------|---------------|---------------|---------------|
| Speed | 4x | 8x | 1x |
| Score | 100 | 95 | 100 |
| Behavioral | 100 | 81 | 100 |
| Teacher Events | 108 | 37 | 114 |
| Student Events | 114 | 37 | 114 |
| Pin Changes (T) | 16 | 5 | 16 |
| Pin Changes (S) | 16 | 5 | 16 |
| Time Drift (1st) | +252ms | -1ms | -33ms |
| Time Drift (last) | +116ms | +1096ms | -8ms |

---

## Issue 1: Event Count Loss at 8x Speed

### Problem
- **Bundle 1 (4x)**: Captured 108–114 events [OK]
- **Bundle 2 (8x)**: Captured only 37 events (66% loss) [FAIL]
- **Bundle 3 (1x)**: Captured 114 events [OK]
- **Pin changes**: 16 at 4x/1x, only 5 at 8x

### Root Cause
The polling fix (`lastPollSimMs` guard) helps but is **still insufficient** at 8x speed. Even with scaling poll interval by speed, the emulator's rapid state changes exceed polling cadence.

### Current Polling Code (worker)
```javascript
const pollIntervalMs = Math.max(10, Math.round(50 / normalizedSpeed)); // 8x → 6.25ms
await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.round(pollIntervalMs / normalizedSpeed)))); // 8x → 1ms wall-clock
... 
if (nowMs - lastPollSimMs < pollIntervalMs) { continue; } // Guarding with sim-time
```

**Issue**: Even at 8x speed with a nominal 6ms interval, the emulator updates state at microsecond granularity. Between polls, multiple GPIO transitions occur and are lost.

### Solution: Adaptive Polling with Event Buffer
Increase poll frequency at high speeds and use a rolling buffer to capture state transitions missed between samples:

```javascript
// Enhanced polling for 8x speed
const pollIntervalMs = Math.max(5, Math.round(40 / normalizedSpeed)); // 8x → 5ms (was 6ms)
const buffering_enabled = normalizedSpeed >= 4; // Buffer for 4x and above

// Detect state changes by comparing snapshots
const prev_gpio_state = {};
const curr_gpio_state = {};

// In loop: capture multiple snapshots per cycle at 8x
for (let retries = 0; retries < 3 && nowMs - lastPollSimMs < pollIntervalMs; retries++) {
  const micro_snapshot = n.getRichTelemetrySnapshot({mode: 'delta'});
  // Look for GPIO transitions, record all state changes
}
```

**Expected Outcome**: 8x should capture 14+ pin changes (was 5, goal ≥14).

---

## Issue 2: Time Drift Accumulation

### Problem
Time drift (student event timestamp − teacher event timestamp) grows dramatically at 8x:

- **Bundle 1 (4x)**: Drift evolves from +252ms → +116ms (improves over time) [OK]
- **Bundle 2 (8x)**: Drift evolves from -1ms → +1096ms (worsens severely) [FAIL]
- **Bundle 3 (1x)**: Drift stays within ±33ms (stable) [OK]

**Visualization**:
```
4x:  +252ms --------→ +116ms  [converging, forgiving]
8x:  -1ms  --------→ +1096ms [diverging, penalizing]
1x:  -33ms --------→ -8ms    [stable, minimal]
```

### Current Time-Drift Penalty (Rust)
```rust
// In lib.rs: compare_events_indexed()
let adaptive_tolerance = match speed_factor {
    1.0 => 50,
    2.0 => 200,
    4.0 => 800,
    8.0 => 1200,  // Max 1200ms tolerance
    _ => 1200,
};

// Penalty applied for drift > tolerance
if drift > adaptive_tolerance {
    penalty_applied = true;
    match_pct -= 15; // Fixed 15% penalty
}
```

### Why Scoring Failed at 8x (Behavioral = 81)
- Tolerance = 1200ms
- Accumulated drift reached 1096ms (within tolerance at end)
- But **transient drift** at mid-stream (around 5000ms) likely exceeded 1200ms
- **19% behavioral loss** → 100 - 19 = **81 score**

### Solution: Forgiving Time-Drift Matching

```rust
// NEW: Adaptive time-drift tolerance that increases with clock accumulated error
fn calculate_adaptive_tolerance(speed_factor: f32, accumulated_clock_error: i32) -> i32 {
    let base_tolerance = match speed_factor {
        1.0 => 50,
        2.0 => 200,
        4.0 => 800,
        8.0 => 1200,
        _ => 1200,
    };
    
    // Allow extra tolerance for accumulated error at high speeds
    let drift_buffer = (accumulated_clock_error as f32 * 0.05).ceil() as i32; // 5% of error
    (base_tolerance + drift_buffer).min(2000) // Cap at 2000ms
}

// NEW: Phase-shift recovery with drift forgiveness
// If match fails with strict timing, try with +/- phase offsets
for phase_offset in [-200, -100, 0, 100, 200].iter() {
    adjusted_time = teacher_time + phase_offset + accumulated_drift;
    if (student_time - adjusted_time).abs() < adaptive_tolerance {
        // Mark as "time drift" (not penalized as heavily as "unmatched")
        status = "time_drift";  // vs "unmatched"
        match_found = true;
        break;
    }
}

// Only apply heavy penalty for true "unmatched" (no phase can reconcile)
if status == "time_drift" {
    penalty_applied = false;  // No penalty for time drift
} else if status == "unmatched" {
    penalty_applied = true;   // Penalty only for true mismatches
}
```

---

## Issue 3: Extra Student Events (Not a Score Deduction)

### Finding
Bundle 1 has 6 extra student events (114 vs 108) but **still scores 100**. [OK]

Why? The extra-event tolerance is working:
```rust
// In lib.rs: compare_events_indexed()
let extra_tolerance = (teacher_events.len() as f32 * 0.20).ceil() as usize;
// 108 teacher events × 20% = 21.6 → 22 allowed surplus
// 114 - 108 = 6 extra < 22 → NO PENALTY
```

### Teacher with Extra Event (Your Question)

**Scenario**: Teacher has an extra event at 7900+ms (cutoff), but student doesn't.

**Current Behavior**:
```rust
// Events at t > 7900ms are moved to ignored_events
if event_time_ms > 7900 {
    ignored_events.push(event);  // Separated from main matching
}
// Cutoff-only mismatches don't affect score (intended behavior)
```

**If teacher has extra at 7800ms** (before cutoff) **and student doesn't**:
```rust
// Teacher event list: [... event_7800, ...]
// Student event list: [... event_7700, ...]
// Mismatch: Teacher has event student lacks
// This DOES count toward unmatched_count
// Behavioral penalty: 10-19% depending on match_percentage
```

### Recommendation: Mark as "Grace" Event (No Deduction)

**NEW Logic**: If an event exists only on teacher side and is within last 200ms of recording window, mark as "grace" (no penalty):

```rust
if teacher_only_event && event_time_ms > 7700 {
    // Mark as "grace" in temporal_breakdown
    grace_events.push(event);
    // No penalty applied
} else if teacher_only_event {
    // True mismatch, apply penalty
    unmatched_events.push(event);
}
```

---

## Issue 4: MIP Mapping (Maximum Bipartite Matching)

### What is MIP Mapping?

**MIP** = **M**aximum **I**ndependent **P**erfect Matching in bipartite graphs.

In grading context: **Optimally pair teacher events with student events** such that:
1. Each teacher event matches at most one student event
2. Each student event matches at most one teacher event
3. Total match score is maximized

### Why Use MIP Instead of Simple Linear Matching?

**Problem with linear matching** (old approach):
```
Teacher Events:  [A1 @100ms, A2 @200ms, A3 @300ms]
Student Events:  [B1 @105ms, B2 @250ms]

Linear scan (left→right):
- A1 @100ms → B1 @105ms (5ms drift) [YES] Matched
- A2 @200ms → unmatched [NO] (B1 already used, B2 is 50ms away)
- A3 @300ms → unmatched [NO]

Result: 1/3 matched = 33% score [FAIL]
```

**With MIP matching** (optimal):
```
Consider ALL possible pairings:
- Option 1: (A1→B1, A2→B2, A3→unmatched) = 2 matches + drift penalties
- Option 2: (A1→unmatched, A2→B2, A3→unmatched) = 1 match
- ...

Algorithm picks option with highest score by trying all permutations
with sliding-window phase offsets

Result: 2/3 matched + time-drift notes = 67% with explanations [YES]
```

### Current MIP Implementation (Rust lib.rs)

```rust
pub fn compare_events_indexed(
    teacher_events: &[TelemetryEvent],
    student_events: &[TelemetryEvent],
    speed_factor: f32,
) -> (f32, Vec<String>) {
    let mut best_match_pct = 0.0;
    
    // Try different phase offsets (sliding window)
    for phase_offset in [
        -TIMELINE_WINDOW,
        -TIMELINE_WINDOW / 2,
        0,
        TIMELINE_WINDOW / 2,
        TIMELINE_WINDOW,
    ]
    .iter()
    {
        // For each phase, test index-by-index matching
        let (match_pct, matches_this_phase) = match_with_phase(*phase_offset);
        
        if match_pct > best_match_pct {
            best_match_pct = match_pct;
            // Record this as best so far
        }
    }
    
    (best_match_pct, recorded_matches)
}

// Index-by-index: assumes events at index i should match within tolerance
fn match_with_phase(phase_offset: i32) -> (f32, usize) {
    let mut matched_count = 0;
    
    for (i, t_event) in teacher_events.iter().enumerate() {
        if i < student_events.len() {
            let s_event = &student_events[i];
            let adjusted_t_time = get_event_time(t_event) + phase_offset;
            let s_time = get_event_time(s_event);
            
            if (s_time - adjusted_t_time).abs() < ADAPTIVE_TOLERANCE {
                matched_count += 1;
            }
        }
    }
    
    let match_pct = (matched_count as f32 / teacher_events.len() as f32) * 100.0;
    (match_pct, matched_count)
}
```

### Why MIP Works Better for 8x Speed

At 8x, events are packed tightly and timing variance is high. MIP:
- **Tries multiple phase offsets** before declaring a mismatch
- **Allows "drift" re-interpretation**: A late student event can match an early teacher event if within tolerance + phase
- **Maximizes total matches**: Doesn't commit to greedy first match; explores all options

---

## Solutions Summary & Action Items

### [OK] IMPLEMENTED
1. **Simulation-time aware polling**: Guard with `lastPollSimMs` 
2. **Component ID normalization**: All components use prefix + map lookup
3. **Extra-event tolerance**: 20% student surplus allowed
4. **Phase-shift recovery**: Up to ±TIMELINE_WINDOW (400ms)
5. **Speed parameter threading**: Rust receives `simulation_speed` in options
6. **Temporal cutoff (7900ms)**: Ignored events don't penalize fidelity

### 🔴 NEEDS FIXING (Immediate)
1. **Increase polling frequency for 8x**: Reduce poll interval from 6ms to 5ms, add multi-snapshot buffering
2. **Time-drift tolerance scaling**: Allow +5% drift buffer at high speeds instead of fixed penalty
3. **Grace events**: Teacher-only events in last 200ms should not penalize

### 🟡 OPTIONAL IMPROVEMENTS
1. Implement full bipartite matching (exponential cost, likely overkill)
2. Decrease TIMELINE_WINDOW from 400ms to 200ms for tighter phase locks
3. Add predictive event tracking (estimate next event time, alert if missed)

---

## Time-Drift Handling: Detailed Explanation

### Current System (Rust Temporal Matching)

```rust
// Timeline window: how much we allow teacher/student times to shift
const TIMELINE_WINDOW: i32 = 400; // milliseconds

// Adaptive tolerance scales with speed
fn get_adaptive_tolerance(speed_factor: f32) -> i32 {
    match speed_factor {
        1.0 => 50,    // 1x: tight ±50ms window
        2.0 => 200,   // 2x: ±200ms (accumulated jitter)
        4.0 => 800,   // 4x: ±800ms (significant jitter expected)
        8.0 => 1200,  // 8x: ±1200ms (aggressive tolerance)
        _ => 1200,
    }
}
```

### Time-Drift Scenarios

#### Scenario A: ±50ms Drift (1x speed, acceptable)
```
Teacher Event: Pin 13 HIGH @ 100ms
Student Event: Pin 13 HIGH @ 140ms
Drift: +40ms (within ±50ms tolerance)
Status: "matched"
Penalty: NONE
```

#### Scenario B: +400ms Drift (4x speed, within phase-shift window)
```
Teacher Event: Pin 13 HIGH @ 1000ms
Student Event: Pin 13 HIGH @ 1400ms
Drift: +400ms (exactly at TIMELINE_WINDOW boundary)
Status: Try phase_offset +400ms → "matched" with phase recovery
Penalty: NONE (forgiven by phase-shift logic)
```

#### Scenario C: +1500ms Drift (8x speed, exceeds tolerance)
```
Teacher Event: Pin 13 HIGH @ 1000ms
Student Event: Pin 13 HIGH @ 2500ms
Drift: +1500ms (exceeds ±1200ms tolerance)
Status: Tried all phases, still can't match → "unmatched"
Penalty: YES, -10% behavioral score
```

### Why Bundle 2 (8x) Scored 81 (Not 100)

The behavioral score dropped to 81 because:
1. **Only 5 pin changes captured** (should be 16) → 5/16 = 31% match
2. **Time drift peaks at +1096ms** during middle section → several events forced into "unmatched" category
3. **Combined penalty**: (31% match) + (time-drift penalties) = ~19% total loss → Score 81

---

## MIP Mapping vs. Current Indexed Matching

### Visual Comparison

**Scenario**: 3 Teacher events, 3 Student events (different times)

```
INDEXED MATCHING (Current):
T1 (100ms) ──┐
T2 (200ms) ──┼──→ S1 (105ms) [YES]
T3 (300ms) ──┘    S2 (250ms) [NO]
              S3 (350ms) [NO]
Result: 1/3 = 33%

MIP MATCHING (Optimal):
T1 (100ms) ──→ S1 (105ms) [YES]     [5ms drift]
T2 (200ms) ──→ S2 (250ms) [YES]     [50ms drift]
T3 (300ms) ──→ S3 (350ms) [YES]     [50ms drift]
Result: 3/3 = 100%
```

### Why We Use "Indexed" Instead of Full MIP

1. **Complexity**: Full MIP requires O(n³) time; we use O(n) per phase
2. **Assumption validity**: Events usually occur in same order at both T and S, just with timing shifts
3. **Phase-offset recovery**: By trying multiple phases, we capture most of what MIP would find
4. **Sufficient performance**: Current method (indexed + phases) achieves 81–100% match rates

---

## Code Changes Needed

### File 1: `openhw-studio-grading-engine/src/lib.rs`

**Change 1**: Reduce time-drift penalty for high speeds

```rust
// BEFORE (line ~805)
if drift > adaptive_tolerance {
    penalty_applied = true;
    match_pct -= 15; // Always -15%
}

// AFTER
if drift > adaptive_tolerance {
    // Only penalize if VERY out of sync (beyond 2x tolerance)
    if drift > adaptive_tolerance * 2 {
        penalty_applied = true;
        match_pct -= 15;
    } else {
        // Mark as "time_drift" (recorded but not heavily penalized)
        status = "time_drift";
        penalty_applied = false;
    }
}
```

**Change 2**: Add grace events (teacher-only at end of window)

```rust
// NEW: In compare_behavior() around line 625
let grace_window_start = 7700; // 200ms before cutoff
for event in &teacher_only_events {
    let event_time = get_event_time(event);
    if event_time > grace_window_start {
        grace_events += 1;
        // Don't count toward unmatched
    } else {
        unmatched_events += 1;
    }
}
```

### File 2: `OpenHW-studio-frontend/src/worker/grading-engine.worker.ts`

**Change**: Increase polling and buffer events at 8x

```javascript
// BEFORE (line ~250)
const pollIntervalMs = Math.max(10, Math.round(50 / normalizedSpeed));
await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.round(pollIntervalMs / normalizedSpeed))));

// AFTER
const pollIntervalMs = normalizedSpeed >= 4 
    ? Math.max(4, Math.round(40 / normalizedSpeed))  // 8x → 5ms (was 6ms)
    : Math.max(10, Math.round(50 / normalizedSpeed));

const sleep_wall_ms = Math.max(1, Math.round(pollIntervalMs / (normalizedSpeed * 1.5))); // More aggressive
await new Promise(resolve => setTimeout(resolve, sleep_wall_ms));
```

---

## Testing Strategy

### Test Case 1: Verify Event Capture at 8x
```
Input: Same circuit as Bundle 2
Expected: 14+ pin changes (was 5)
Expected: 80+ total events (was 37)
Expected: Behavioral ≥ 95 (was 81)
```

### Test Case 2: Time-Drift Handling
```
Input: Introduce +500ms systematic delay in student
Expected: Status "time_drift", not "unmatched"
Expected: No behavioral penalty (or <5%)
```

### Test Case 3: Grace Events
```
Input: Teacher has event at 7850ms, student doesn't
Expected: Marked as "grace", no score penalty
```

---

## Implementation Priority

1. **🔴 High**: Polling fix for 8x (5% event loss → 95% capture)
2. **🔴 High**: Grace events logic (teacher-only at cutoff)
3. **🟡 Medium**: Time-drift forgiveness (reduce penalty variance)
4. **🟢 Low**: Full MIP implementation (current phased approach sufficient)



