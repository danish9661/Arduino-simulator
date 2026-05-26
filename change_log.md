# Change Log & Audit Trail

## Conversation: c81c5a98-5a3c-44c7-9340-2aa559e90e5c (2026-05-19)

### Modified Files:
1. **[openhw-studio-autowiring-engine/src/lib.rs](file:///c:/Users/Danish/Documents/simulator/openhw-studio-autowiring-engine/src/lib.rs)**:
   *   **Universal Autowiring Tracing**: Implemented universal autowiring connection tracing in `generate_code_for_component` and `generate_autonomous_setup`. Allows composite, helper-based components (like `openhw-motor` with `openhw-motor-driver`) to dynamically resolve and update their board pin assignments exactly like direct components (like `openhw-led`). Added explicit `conn.via` component tracing and commented out the legacy hardcoded 2-pin bridging rule in `get_connected_net` to prevent conflicts and ensure 100% manifest-driven routing. Added dynamic `${COMP_ID}` and `${COMP_SUFFIX}` replacement to support multiple instances of identical components without C++ variable name collisions.
2. **[openhw-motor/manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-motor/manifest.json)**:
   *   **Universal Placeholder Migration**: Replaced invalid C++ macro placeholders (`[[helper:driver:ENA|ENB]]`, etc.) with universal `${helper:driver:ENA|ENB}` placeholders. Stripped redundant `void setup()` and `void loop()` wrappers.
3. **[openhw-stepper-motor/manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-stepper-motor/manifest.json)**:
   *   **Universal Placeholder & Multi-Instance Migration**: Replaced hardcoded pin numbers (`8, 9, 10`) with universal placeholders (`${helper:driver:STEP}`, `${helper:driver:DIR}`, `${helper:driver:ENABLE}`). Replaced hardcoded `stepper` variable name with `stepper_${COMP_SUFFIX}` to prevent variable name collisions when multiple stepper motors are connected. Moved `#include <AccelStepper.h>` and object declaration to `globals`. Connected `RESET` and `SLEEP` to `5V` and pulled `ENABLE` LOW.
4. **[openhw-rgb-led/manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-rgb-led/manifest.json)**:
   *   **Macro & Structure Fix**: Moved `#define PIN_R 9`, `#define PIN_G 10`, `#define PIN_B 11` to `globals`. Removed invalid `arduino:9|6|3` syntax. Stripped redundant `void setup()` and `void loop()` wrappers.
5. **[openhw-servo/manifest.json](file:///c:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-servo/manifest.json)**:
   *   **Library Dependency Fix**: Added `"libraries": ["Servo"]` array to ensure proper library resolution during automated code generation.
6. **Mass Manifest Migration (20 Component Manifests)**:
   *   **Universal Placeholders & Collision Prevention**: Audited all remaining ~60 component manifests and updated the 20 components containing autocoding blocks (`openhw-ldr-module`, `openhw-hc-sr04`, `openhw-a4988`, `openhw-motor-driver`, `openhw-pushbutton`, `openhw-buzzer`, `openhw-potentiometer`, `openhw-photoresistor`, `openhw-ntc-temperature-sensor`, `openhw-ssd1306-oled`, `openhw-sd-card`, `openhw-nokia-5110`, `openhw-membrane-keypad`, `openhw-max7219`, `openhw-lcd2004-i2c`, `openhw-lcd1602-i2c`, `openhw-ili9341`, `max30102`). Replaced all hardcoded pin numbers with dynamic placeholders (e.g. `${TRIG}`, `${ECHO}`, `${CS}`, `${STEP}`, `${DIR}`, `${ENABLE}`) and appended `${COMP_SUFFIX}` to all C++ variable names, arrays, and object declarations to prevent global scope collisions when multiple instances are present.
18. **[execute.ts](file:///c:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts)**:
    *   **Composite Helper Voltage Propagation**: Discovered and fixed a major architectural gap in `AVRRunner` where `repropagateAllVoltages` only propagated voltages starting from Arduino board pins (`uno1`). Because composite helper components (like `openhw-power-supply` and `openhw-a4988`) connect to each other and to destination components via wires independent of the board (e.g. `power-supply:5V -> a4988:VMOT`, `a4988:1A -> stepper-motor:A+`), their generated output voltages were never propagated across the wires, resulting in 0V at the destination pins. Updated `updateOopPin` to accept `customCompId` and updated `repropagateAllVoltages` to repropagate active driver outputs from non-board helper components (`a4988`, `motor-driver`, `logic-gate`, `power-supply`) across connected wires. Updated `COMPONENT_PINS` for power supply to include `5V` alongside `VCC` and `GND`.
19. **Explanation of `stepper.json` Code Generation**:
    *   **Legacy Project File Analysis**: Examined `workflow/stepper.json` and identified an `exportedAt` timestamp of `2026-05-18T20:55:05.416Z`, confirming it was saved *before* the mass manifest migration was performed on `openhw-stepper-motor` (which took place during Request 9). At the time `stepper.json` was saved, `openhw-stepper-motor/manifest.json` still contained the legacy hardcoded autocoding block without `${COMP_SUFFIX}` or dynamic `${helper:driver:STEP}` placeholders.

### Reasoning:
*   Enables truly universal dynamic pin replacement for complex composite components across the entire emulator.
*   Prevents `#include` directives, `#define` macros, and global object declarations from being incorrectly generated inside function blocks during automatic code generation.
*   Corrects A4988 driver simulation logic where floating active-LOW `ENABLE`, `SLEEP`, and `RESET` pins kept the driver in an inactive (`active: false`) freewheeling state.
*   Ensures all 24 autocoding-enabled manifests adhere to the standardized `globals`, `setup`, `loop`, and `libraries` schema.
*   Fixes the root cause of 0V on destination pins for composite helper components by ensuring their active driver outputs are correctly propagated across wires during simulation runs.

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

## Conversation: 5611efe3-5194-42dd-9f1e-e997c60e046a (2026-05-25)

### Modified Files:
1. **[compileController.js](file:///c:/Users/Danish/Documents/simulator/openhw-studio-backend/src/esp32/controller/compileController.js)**:
   * **SPI Shim Registration**: Added `SimulatorSPI.h` (mapped to `SPI.h`) and `SimulatorSPI.cpp` (mapped to `SPI.cpp`) to the `SHIM_HEADERS` collection. This ensures that any compiled sketch including `<SPI.h>` will compile against our custom simulation shim rather than the core Arduino ESP32 SPI hardware driver.
2. **[SimulatorSPI.h](file:///c:/Users/Danish/Documents/simulator/openhw-studio-backend/src/esp32/utils/SimulatorSPI.h)**:
   * **New File**: Created a pure-ASCII, sim-compatible SPI header that defines `SPISettings` and `SPIClass` with all standard ESP32 Arduino Core class member function declarations (like `begin`, `end`, `transfer`, `transferBytes`, `write`, `writeBytes`, `writePixels`, `writePattern`).
3. **[SimulatorSPI.cpp](file:///c:/Users/Danish/Documents/simulator/openhw-studio-backend/src/esp32/utils/SimulatorSPI.cpp)**:
   * **New File**: Implemented `SPIClass` shim logic. For single-byte operations, it outputs `>SPI:xx<` UART frames. For bulk transfers/writes (`writeBytes`, `writePixels`, `transferBytes`), it chunks the input buffer into segments of max 128 bytes (preventing stack overflows in the ESP32 task) and formats them as `>SPIBUF:<hexdata><` frames. All messages are emitted safely via the serial mutex using the non-static `sim_wire_emit` wrapper.

### Reasoning:
* Fixes the severe host CPU load and user interface lag caused by the real ESP32 core SPI driver busy-waiting on emulated SPI hardware registers in QEMU.
* Fixes the `Guru Meditation Error: Core / panic'ed (Cache error)` crashes during QEMU simulation of TFT LCDs.
* Enables display data to actually flow to the frontend (via WebSocket `SPI_BATCH` events) so that the virtual TFT LCD and ePaper displays can render visual screen updates smoothly.
