# FEATURE: Intelligent Board Compatibility Check

## Overview
This feature grays out boards in the "Wire To" context menu if they lack the available pins or resources to support the selected component. This prevents user frustration and provides immediate feedback on circuit constraints.

## Proposed Logic
1.  **Trigger**: When `ComponentContextMenu` is opened for a component.
2.  **Dry Run**: Perform a background "Dry Run" using the WASM Autowiring Engine for every programmable board currently on the canvas.
3.  **State**: Store results in a `boardCompatibilityMap` (e.g., `{ "uno1": true, "pico1": false }`).
4.  **UI**: Pass this map to the context menu to `disable` and `opacity-reduce` incompatible boards.

## Caching & Performance Optimizations

### 1. Result Memoization
Since re-running the WASM engine for every right-click is redundant if the circuit hasn't changed, we should implement a cache:
- **Key**: `compId + boardId + JSON.stringify(wires.length)` (or a hash of the netlist).
- **Storage**: A `useRef` map in `SimulatorPage.jsx`.
- **Invalidation**: Clear the cache whenever a wire is added, a component is moved, or `autoWiringEnabled` is toggled.

### 2. Parallel Worker Execution
Currently, we have one Autowiring Worker. To optimize:
- Use `Promise.all()` to fire off all 5 board checks simultaneously.
- Even with one worker, the message queue handles this efficiently, but we could eventually move to a **Worker Pool** if we have 10+ boards.

### 3. "Just-in-Time" vs "On-Open"
- **On-Open (Current Plan)**: Start checks the moment the right-click happens.
- **On-Hover (Alternative)**: Only check a specific board when the user hovers over "Wire To" or that specific board name. 
- **Recommendation**: Stick to "On-Open" for 5 boards (very fast), but switch to "On-Hover" if the number of boards exceeds 10.

## Logic Proof (Alert Fix)
To fix the silent failure in `handleWireToBoard`, we must add:
```javascript
const plan = await generateAutonomousSetup(...);
if (plan?.reasoning) {
  const critical = plan.reasoning.find(r => r.toUpperCase().includes('CRITICAL'));
  if (critical) alert(critical);
}
```

## Future Proofing
In the future, the context menu could show a "Reason" for the gray-out on hover (e.g., "Not enough PWM pins" or "I2C bus full"). This information is already provided by the WASM engine's `reasoning` array.



# FEATURE: Intelligent Board Compatibility Check
Overview
This feature grays out boards in the "Wire To" context menu if they lack the available pins or resources to support the selected component.

User Review Required
IMPORTANT

The compatibility check will be performed automatically whenever a component is right-clicked. This uses the WASM engine in a background worker.

Proposed Changes
SimulatorPage.jsx
State & Cache:
Add boardCompatibility state.
Add compatibilityCache ref for memoization.
Logic:
Implement runBoardCompatibilityCheck(compId) which tests all boards and updates state.
Update handleWireToBoard to report critical errors via alert.
Trigger: Call runBoardCompatibilityCheck in the right-click handler.
ComponentContextMenu.jsx
Props: Add boardCompatibility prop.
UI: Disable buttons and add opacity: 0.5 for boards marked as incompatible.
Caching Strategy
Result will be cached per compId and boardId.
Cache is invalidated on any circuit change (components/wires length change).
Verification Plan
Add multiple boards (Arduino, Pico).
Add a component that only works on one (e.g. requires specific pins).
Right-click and hover "Wire To".
Verify: Incompatible boards are grayed out.
Verify: No lag in menu opening.

