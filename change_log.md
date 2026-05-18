# Change Log & Audit Trail

## Conversation: 42a9bf94-3a04-4769-9b93-4c92a0721d37 (2026-05-18)

### Modified Files:
1. **[config.mts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/.vitepress/config.mts)**:
   *   **VitePress Sidebar Integration**: Added the newly arranged markdown files to Getting Started, Architecture, Telemetry, and Components sections, and created a brand new **Classroom System** category.
2. **[openhw-studio-docs/classroom/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/classroom)**:
   *   **Classroom Folder Creation**: Created a new directory dedicated to classroom system documentation.
   *   Moved 6 classroom-specific files: `api-routing.md`, `api-workflows.md`, `data-architecture.md`, `live-simulation.md`, `student-dashboard.md`, and `teacher-dashboard.md` here.
3. **[openhw-studio-docs/architecture/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/architecture)**:
   *   Moved `block-coding.md` and `frontend-engine.md` here.
4. **[openhw-studio-docs/components/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/components)**:
   *   Moved `component-lab.md` here.
5. **[openhw-studio-docs/guides/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/guides)**:
   *   Moved `hardware-flashing.md` here.
6. **[openhw-studio-docs/telemetry/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/telemetry)**:
   *   Moved and renamed `component_telemetry_reference.md` to `component-telemetry-reference.md` and `telemetry_architecture.md` to `telemetry-architecture.md`.
7. **[openhw-studio-docs/arrange/](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/arrange)**:
   *   **Cleanup**: Removed the temporary `arrange` directory, cleaning up the duplicate `hardware-flashing (1).md` file in the process.

### Reasoning:
*   Organizes the scattered documentation files under `openhw-studio-docs` into a logical, highly structured folder hierarchy.
*   Introduces the **Classroom System** documentation section to VitePress, providing clean navigation links for students, teachers, APIs, and real-time collaboration.
*   Enforces kebab-case file naming consistency across the telemetry documentation.

## Conversation: 40b201f5-035f-4699-936d-abf43c4e6765 (2026-05-18)

### Modified Files:
1. **[BaseComponent.ts](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/BaseComponent.ts)**:
   *   **Stability Refinements**: Refined the `hasStabilized()` heuristic to check both pin voltages and `lastIoAtMs`/`lastEventAtMs` to prevent false positives when asynchronous serial/protocol transfers are active.
   *   **Base Sync State**: Added the universal telemetry runtime parameters and pin toggles to the base component's `getSyncState()` method.
2. **[execute.ts](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts)**:
   *   **Protocol Payloads**: Updated standard TWI/SPI adapters and Hooks to emit correctly formatted `protocol:i2c` and `protocol:spi` payload events.
   *   **Unified Sync State Merging**: Implemented `getUnifiedComponentSyncState()` to merge base universal telemetry sync state with subclass state outputs for complete diagnostics.
   *   **Board Pin Tracking**: Updated `propagateBoardPin` in `AVRRunner` and `RP2040Runner` to propagate state changes directly to the microcontroller board components via `boardInst.onPinStateChange`.
3. **[SimulatorPage.jsx](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/pages/simulationpage/SimulatorPage.jsx)** & **[SimulatorPage.jsx](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/pages/mobileui/SimulatorPage.jsx)**:
   *   **Console Crash Prevention**: Replaced storing the raw protocol analyzer log object with storing `log.message` directly in `protocolLogs` to prevent `TypeError` startsWith crashes.
4. **[SimulationConsole.jsx](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/pages/simulationpage/SimulationConsole.jsx)**:
   *   **Aesthetics and Visibility**: Bound the visual visibility of the `🏷️ I/O Throughput` panel to the `showBusTraffic` configuration setting. Styled the I/O throughput container with a gorgeous premium gold and yellow-accent theme.

### Reasoning:
*   Restores robust bus traffic reporting for I2C and SPI without breaking existing telemetry or incurring performance overhead.
*   Fixes potential runtime console crashes when active bus communication traffic is detected.
*   Enhances aesthetic quality and diagnostic control by allowing the user to filter bus throughput under a unified toggle.

## Conversation: 1393d434-2e73-4732-9fcb-c65757941aee (2026-05-18)

### Modified Files:
1. **[ui.tsx](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-buzzer/ui.tsx)**:
   *   **Optimizations**: Replaced node-recreation audio loops (creating/destroying oscillator and gain nodes on each keypress) with a persistent, low-latency background oscillator initialized on mount.
   *   **Audio Tuning**: Configured `AudioContext` with `latencyHint: 'interactive'` to force low-latency hardware buffer settings.
   *   **Gain Modulation**: Sound trigger is now mediated by instant gain/volume transitions (between target volume and `0`), bypassing all node construction overhead.
2. **[SimulatorPage.jsx](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/pages/simulationpage/SimulatorPage.jsx)**:
   *   **State Tracking**: Added `buttonInteractStartTimeRef` to track exact start times of pushbutton piano presses.
   *   **High-Precision Logging**: Inside `attrs.onInteract` and `worker.onmessage` state loops, calculates round-trip latency (from user keystroke in the browser main thread $\rightarrow$ simulated CPU $\rightarrow$ worker output $\rightarrow$ back to browser) and logs it in the developer console (`F12`) with warning alerts for delays exceeding `80ms`.
3. **[execute.ts](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts)**:
   *   **State Decoupling**: Added a `pendingVisualStateEmit` flag to components within the `AVRRunner` instance.
   *   **Task update**: When component updates yield a state transition, the runner flags the component with a pending emit before clearing `stateChanged` for voltage calculations.
   *   **State Emission**: In `emitStateIfDue`, allows state emission to the browser UI thread if either `stateChanged`, `pendingVisualStateEmit`, or `telemetryEnabled` is active, resetting both flags on dispatch.

### Reasoning:
*   Resolves high-density tone playback lag and startup latency on first press.
*   Enables real-time diagnostic auditing of user-perceived simulator latency via browser developer tools.
*   Fixes the bug where components (buzzer, LEDs) only make sound or animate when the UI Console Telemetry logging panel is active by decoupling state emission logic from the transient voltage propagation clean-up.

## Conversation: bd617d00-926b-46b6-ab30-4a7d87706e5e (2026-05-19)

### Modified Files:
1. **Git Commit History Consolidation**:
   *   **History Cleanup**: Consolidated 3 local unpushed commits into a single clean commit (`fix: simulation page updates, component debug, UI editor improvements, and validation fixes`).
   *   **Large File Removal**: Completely stripped the intermediate addition and deletion of `OpenHW-studio-frontend.zip` (1033.42 MB) from the git commit history.
   *   **Successful Push**: Successfully pushed the consolidated changes to `https://github.com/danish9661/Arduino-simulator.git` (`main -> main`).

### Reasoning:
*   Resolves the GitHub large file rejection error (`GH001: Large files detected; exceeds GitHub's file size limit of 100.00 MB`).
*   Maintains working directory integrity and preserves all previous code modifications exactly as intended without data loss.

