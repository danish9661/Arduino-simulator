# Complete Grading Score Calculation Guide

**Reference**: Full scoring system with formulas, weightages, and real examples  
**Version**: v2.5 (Fixed 400ms tolerance)  
**Date**: May 9, 2026

---

## Quick Reference: Overall Score Formula

```
OVERALL SCORE = 0.25 × S + 0.25 × L + 0.40 × B + 0.10 × C

Where:
  S = Spatial Score (0-100)
  L = Logic Score (0-100)
  B = Behavioral Score (0-100) ⭐ MOST IMPORTANT (40% weight)
  C = Code Score (0-100)
```

**Example**:
```
S=100, L=100, B=95, C=100
Overall = 0.25(100) + 0.25(100) + 0.40(95) + 0.10(100)
        = 25 + 25 + 38 + 10
        = 98/100 [YES]
```

---

## Category 1: SPATIAL SCORE (25% weight)

### What It Measures
- Component placement accuracy in circuit
- Correct wire connections
- Ground/power routing

### Calculation Formula

```
Spatial_Score = 100 - (misaligned_components × 10)

Min: 0 (all components wrong)
Max: 100 (all correct)
```

### Penalty Structure

| Issue | Points Lost |
|-------|------------|
| Component not in wokwi | -100 (fail) |
| Wrong component type | -50 |
| Misaligned position | -10 |
| Wrong pin connected | -20 |
| Ground not connected | -25 |

### Detailed Example: LED Circuit

**Teacher's circuit**:
```
Arduino Pin 13 ──┬─── LED Anode
                 └─── Resistor ── GND
```

**Scenario A: Student copies perfectly**
```
Spatial components verified [YES]
→ Spatial_Score = 100
```

**Scenario B: Student uses Pin 12 instead**
```
Wrong pin connection: -20 points
→ Spatial_Score = 80
```

**Scenario C: Student uses wrong LED color**
```
Wrong component type: -50 points
→ Spatial_Score = 50
```

---

## Category 2: LOGIC SCORE (25% weight)

### What It Measures
- Program logic correctness
- Variable initialization and updates
- Conditional statement accuracy
- Loop correctness
- State management

### Calculation Formula

```
Logic_Score = 100 - Σ(penalty_per_issue)

Penalties:
  Variable mismatch: -2 points each
  State error: -3 points each
  Logic flow error: -5 points each
  Missing condition: -4 points each

Min: 0 (all logic wrong)
Max: 100 (all correct)
```

### Event-Level Logic Penalties

```
VARIABLE MISMATCH (-2 pts each)
  Teacher state: int ledPin = 13
  Student state: int ledPin = 12  ← Wrong!
  Penalty: -2 points

STATE ERROR (-3 pts each)
  Teacher: if (ledState == HIGH) { digitalWrite(...) }
  Student: if (ledState == LOW) { digitalWrite(...) }   ← Inverted!
  Penalty: -3 points

LOGIC FLOW ERROR (-5 pts each)
  Teacher: delay(500); digitalWrite(HIGH); delay(500);
  Student: digitalWrite(HIGH); delay(500);             ← Missing delay!
  Penalty: -5 points

MISSING CONDITION (-4 pts each)
  Teacher: if (sensorValue > 500) { ... }
  Student: digitalWrite(HIGH);                          ← No condition!
  Penalty: -4 points
```

### Detailed Example: Blink Program

**Teacher's code**:
```cpp
int ledPin = 13;
int ledState = LOW;
int delayMs = 500;

void setup() {
  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, ledState);
}

void loop() {
  delay(delayMs);
  ledState = (ledState == LOW) ? HIGH : LOW;
  digitalWrite(ledPin, ledState);
}
```

**Scenario A: Perfect match**
```
[YES] ledPin = 13
[YES] Initial ledState = LOW
[YES] delayMs = 500
[YES] All conditionals match
[YES] Logic flow matches

Logic_Score = 100 - 0 = 100
```

**Scenario B: Wrong pin + missing delay**
```
[NO] ledPin = 12 (mismatch) → -2 pts
[NO] Missing second delay() → -5 pts
(other variables OK)

Logic_Score = 100 - 7 = 93
```

**Scenario C: Multiple errors**
```
[NO] ledPin = 12                    → -2 pts
[NO] Initial ledState = HIGH        → -2 pts
[NO] Missing delay in loop          → -5 pts
[NO] Inverted conditional           → -3 pts

Logic_Score = 100 - 12 = 88
```

---

## Category 3: BEHAVIORAL SCORE (40% weight) ⭐

### Overview

Behavioral scoring measures **timing accuracy** of actual circuit behavior through telemetry event matching.

### Calculation Formula (Complete)

```
Behavioral_Score = min(100, max(50, 100 - Total_Penalties))

Total_Penalties = Σ (penalty_per_event_category)

Where penalty categories:
  1. Time drift violations (> 400ms)      → 3-9 pts each
  2. Unmatched events (no student match)  → 4-8 pts each
  3. Missing pin changes                  → 5 pts each
  4. Extra events (beyond 20% allowance)  → 0.5-1 pt each
  5. Component state mismatches           → 1-2 pts each

Min: 50 (hard floor, prevents cascade failure)
Max: 100 (perfect match)
```

### Event Types and Weights

#### 1. PIN CHANGE Events (WEIGHT: 4) - Highest Priority

**What**: Digital I/O transitions (GPIO pin going HIGH→LOW or LOW→HIGH)

**Example**:
```
Teacher telemetry: PinChange(pin=13, state=HIGH, time_ms=22)
Student telemetry: PinChange(pin=13, state=HIGH, time_ms=25)
```

**Scoring**:
```
Drift = |25 - 22| = 3ms

If drift ≤ 400ms:
  Match! +4 points [YES]
  
If drift 400-500ms:
  Excess = 1ms - 400ms = 100ms
  Severity = ceil(100/100) = 1x
  Penalty = 3 × 1 = 3 points [NO]
  
If drift > 500ms:
  Penalty = 3-9 points (up to 3x multiplier) [NO]
```

**Pin Change Event Example**:
```
Teacher events (pin 13 blink pattern):
  PinChange(13, HIGH, 22ms)   T0
  PinChange(13, LOW,  517ms)  T1
  PinChange(13, HIGH, 1001ms) T2

Student events (captured at 8x speed):
  PinChange(13, HIGH, 25ms)   S0 → matches T0 (drift +3ms [YES])
  PinChange(13, LOW,  519ms)  S1 → matches T1 (drift +2ms [YES])
  PinChange(13, HIGH, 1004ms) S2 → matches T2 (drift +3ms [YES])

All 3 match → Behavioral penalty = 0
Behavioral_Score = 100
```

#### 2. COMPONENT STATE Events (WEIGHT: 2) - Supporting

**What**: Analog measurements (voltage, current, power, brightness)

**Example**:
```
Teacher: ComponentState(wokwi_led_1, status="fully lit", time_ms=61)
Student: ComponentState(wokwi_led_1, status="fully lit", time_ms=65)
```

**Scoring**:
```
Drift = |65 - 61| = 4ms

If drift ≤ 400ms AND value matches:
  Match! +2 points [YES]
  
If drift ≤ 400ms BUT value differs:
  Value mismatch: -2 points [NO]
  
If drift > 400ms:
  Time drift penalty: 1-3 points [NO]
```

**Component State Example**:
```
Teacher LED state transitions:
  T0: status="fully lit", voltage="1.80V", time_ms=61
  T1: status="off", voltage="0.00V", time_ms=551

Student LED state transitions:
  S0: status="fully lit", voltage="1.80V", time_ms=63
  S1: status="off", voltage="0.00V", time_ms=553

Matches:
  S0 → T0 (status match, voltage match, drift +2ms [YES])
  S1 → T1 (status match, voltage match, drift +2ms [YES])

Component state penalty = 0
```

#### 3. SERIAL OUTPUT Events (WEIGHT: 1) - Debug

**What**: Console.print() or Serial.println() output

**Example**:
```
Teacher: SerialOutput(data="Hello", time_ms=1500)
Student: SerialOutput(data="Hello", time_ms=1510)
```

**Scoring**:
```
Drift = |1510 - 1500| = 10ms

If drift ≤ 400ms:
  Match! +1 point [YES]
  
If drift > 400ms:
  Time drift penalty: 1 point [NO]
```

---

### Time Drift Penalty (FIXED 400ms Cap)

**Critical Rule (v2.5)**: ALL speeds use identical 400ms threshold

```
Allowed Drift: 0 ─── 400ms ─── 500ms ─── 600ms ─── 700ms+ ──→
                │      OK      │  1x     │  2x     │ 3x   │
                │   (no penalty)│  severe│ critical│ max  │
                                
Penalty Tiers:
  0-400ms:   0 points   (Match success)
  400-500ms: 3 points   (Mild violation)
  500-600ms: 6 points   (Moderate violation)
  600ms+:    9 points   (Severe violation, capped at 3x multiplier)
```

**Why 400ms?**
```
Polling interval at 8x ≈ 3ms
If polling misses 130+ cycles = 390ms drift possible
Setting threshold at 400ms allows for polling jitter while
still penalizing true timing errors
```

---

### Phase-Shift Recovery

If events don't match at exact index, try ±10 offset:

```
Timeline Matching Algorithm:
  For each teacher event T at index i:
    Try to match with student event S at indices:
      i-10, i-9, ..., i-1, i, i+1, ..., i+9, i+10
    
    If S found within 400ms drift:
      Match at best (lowest drift) index → +weight points [YES]
    
    If no match within window:
      Unmatched event → -penalty points [NO]

Example:
  Teacher events: [E0, E1, E2, E3, E4]
  Student events: [E0', E1', E2', E3', E4', Extra1, Extra2]
  
  E0 matches E0' at exact index 0     [YES]
  E1 matches E1' at exact index 1     [YES]
  E2 matches E2' at exact index 2     [YES]
  E3 matches E3' at exact index 3     [YES]
  E4 matches E4' at exact index 4     [YES]
  Extra1 not matched (extra event)    → small penalty
  Extra2 not matched (extra event)    → small penalty
  
  Result: High behavioral score (5/5 primary matches)
```

---

### Extra Event Tolerance (20% Allowance)

Student can have additional events (debug output, extra sensors):

```
Allowance = ceil(teacher_event_count × 0.20)

Example:
  Teacher events: 100
  Allowance: ceil(100 × 0.20) = 20 extra events allowed
  
  If student has:
    110 events → 10 extra (within 20 allowance) → small penalty (-0.5 pts each)
    120 events → 20 extra (at limit) → no additional penalty
    130 events → 30 extra (exceeds limit by 10) → -1 pt per excess
```

---

### Grace Window (7700-8000ms)

Teacher-only events near simulation end: no penalty

```
Timeline:
0ms ────────── 7700ms ──── 8000ms ───→
   Normal     │  Grace   │ Ignored
   scoring    │  window  │ (beyond cutoff)
             │(no penalty)
             
If last_teacher_event is in grace window:
  → Score = 100 (no penalty for timing variance near end)
  
Example:
  Last teacher event: 7850ms
  Falls in grace window (7700-8000ms)
  → Even if student event at 7950ms (100ms drift)
  → No penalty (grace applied)
  → Behavioral_Score remains high
```

---

### Complete Behavioral Score Example

**Scenario: LED Blink Test (8x speed)**

**Teacher telemetry** (6 pin changes, 12 component states):
```
T0: PinChange(13, HIGH,  75ms)
T1: PinChange(13, LOW,   705ms)
T2: PinChange(13, HIGH,  2305ms)
T3: PinChange(13, LOW,   3905ms)
T4: PinChange(13, HIGH,  6305ms)
T5: PinChange(13, LOW,   [>7900ms, ignored])
+ 12 ComponentState events (LED status, voltage, current)
= 18 total teacher events
```

**Student telemetry** (6 pin changes, 13 component states):
```
S0: PinChange(13, HIGH,  78ms)
S1: PinChange(13, LOW,   708ms)
S2: PinChange(13, HIGH,  2308ms)
S3: PinChange(13, LOW,   3908ms)
S4: PinChange(13, HIGH,  6308ms)
S5: PinChange(13, LOW,   [>7900ms, ignored])
+ 13 ComponentState events (LED status, voltage, current)
+ 1 SerialOutput("DEBUG: Blink complete", 7850ms) [grace window]
= 20 total student events
```

**Matching Process**:
```
Pin Changes (weight 4):
  T0↔S0: drift +3ms [YES] → +4 pts
  T1↔S1: drift +3ms [YES] → +4 pts
  T2↔S2: drift +3ms [YES] → +4 pts
  T3↔S3: drift +3ms [YES] → +4 pts
  T4↔S4: drift +3ms [YES] → +4 pts
  T5 ignored (beyond cutoff)
  Subtotal: 20 pts

Component States (weight 2):
  12 teacher events → 12 student events match
  All within drift tolerance [YES]
  12 × 2 = 24 pts

Serial Output (weight 1):
  1 extra event (within allowance)
  -0.5 pts (minor extra event penalty)

Extra Events:
  1 extra serial output → allowed (allowance = ceil(18 × 0.20) = 4)
  
Total Earned: 20 + 24 - 0.5 = 43.5 points
Total Possible: (6 pins × 4) + (12 states × 2) + (1 serial × 1) = 48.5 points

Base Score: 43.5 / 48.5 = 89.6%

Penalties Applied:
  None (all matches within 400ms tolerance)
  
Final Behavioral_Score = 90 (rounded)
```

---

## Category 4: CODE SCORE (10% weight)

### What It Measures
- Syntax correctness
- Compilation success
- Verified code functionality

### Calculation Formula

```
Code_Score = 100 if (code_compiles AND code_executes) else 0
Code_Score = 105 if (code_compiles AND verified_logic_matches) else 100
```

### Detailed Breakdown

| Condition | Score |
|-----------|-------|
| Code won't compile | 0 |
| Code compiles but crashes | 25 |
| Code runs but logic wrong | 50 |
| Code runs, logic correct | 100 |
| Code + verified logic match | 105 (capped at 100 in final) |

### Example: Blink Program Verification

**Teacher verified code**:
```cpp
void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
```

**Scenario A: Student code matches exactly**
```
[YES] Compiles
[YES] Executes
[YES] Verified code matches
→ Code_Score = 100
```

**Scenario B: Student code has syntax error**
```
[NO] Won't compile
→ Code_Score = 0
```

**Scenario C: Student code has logic bug**
```
[YES] Compiles
[YES] Executes
[NO] Logic doesn't match (e.g., delays swapped)
→ Code_Score = 50
```

---

## Complete Example: Full Grade Calculation

### Example: Student LED Blink Submission at 8x Speed

**Component Scores**:

```
SPATIAL SCORE:
  [YES] Pin 13 correct
  [YES] LED correctly placed
  [YES] Resistor correctly placed
  [YES] All connections correct
  → Spatial_Score = 100

LOGIC SCORE:
  [YES] ledPin = 13 (correct)
  [YES] delayMs = 500 (correct)
  [YES] digitalWrite sequence correct
  [YES] delay sequence correct
  → Logic_Score = 100

BEHAVIORAL SCORE:
  (From previous calculation)
  → Behavioral_Score = 90

CODE SCORE:
  [YES] Compiles successfully
  [YES] Execution matches teacher
  [YES] Verified code matches
  → Code_Score = 100
```

**Overall Calculation**:

```
Overall = 0.25(S) + 0.25(L) + 0.40(B) + 0.10(C)
        = 0.25(100) + 0.25(100) + 0.40(90) + 0.10(100)
        = 25 + 25 + 36 + 10
        = 96/100 [YES][YES][YES] EXCELLENT SCORE

Report Summary:
┌─────────────────────────────┐
│ GRADING REPORT              │
├─────────────────────────────┤
│ Spatial:     100/100  (25%) │
│ Logic:       100/100  (25%) │
│ Behavioral:   90/100  (40%) │
│ Code:        100/100  (10%) │
├─────────────────────────────┤
│ OVERALL:      96/100  [YES][YES][YES]  │
└─────────────────────────────┘
```

---

## Penalty Summary Table

### Quick Reference: All Penalties

| Issue | Category | Penalty | Notes |
|-------|----------|---------|-------|
| Wrong component type | Spatial | -50 | Component mismatch |
| Misaligned pin | Spatial | -10 | Position error |
| Wrong pin connected | Spatial | -20 | Connection error |
| Variable mismatch | Logic | -2 | Value differs |
| State error | Logic | -3 | Conditional inverted |
| Logic flow error | Logic | -5 | Missing step |
| Drift 400-500ms | Behavioral | -3 | Time violation |
| Drift 500-600ms | Behavioral | -6 | Severe timing |
| Drift 600ms+ | Behavioral | -9 | Critical timing |
| Missing pin change | Behavioral | -5 | Event lost |
| Unmatched event | Behavioral | -4 | No student match |
| Extra event (over 20%) | Behavioral | -1 | Surplus event |
| Code won't compile | Code | -100 | Compilation fail |
| Code logic mismatch | Code | -50 | Logic wrong |

---

## Real-World Example: Troubleshooting Score

### Student Score: 73 (Why low?)

**Breakdown**:
```
Spatial:     100 (correct)
Logic:        95 (small variable mismatch -5)
Behavioral:   45 (major timing issues)
Code:        100 (correct)

Overall = 0.25(100) + 0.25(95) + 0.40(45) + 0.10(100) = 73
```

**Root Cause**: Behavioral score 45 is pulling down grade

**Investigation**:
```
Teacher events: 16 pin changes
Student events: 25 pin changes (9 extra - exceeds 20% allowance!)

Pin Change Matches:
  T0-T8: drift +3-50ms [YES] (8 matches)
  T9-T15: drift +450-550ms [NO] (7 mismatches! All exceed 400ms threshold)

Penalties:
  8 matches × 4 pts = 32 pts
  7 mismatches × 5 pts = 35 pts penalty
  9 extra events (exceeds ceil(16×0.20)=4 allowance) = 5 pts penalty
  
Behavioral score = 100 - 35 - 5 = 60... but capped at 45 by other issues
```

**Solution**: "Student: Fix timing delays in loop—your events are arriving 450-550ms late!"

---

## Summary

**Use this guide to**:
1. [OK] Understand where points are earned/lost
2. [OK] Predict your student's score before grading
3. [OK] Identify root causes of low scores
4. [OK] Provide targeted feedback to students



