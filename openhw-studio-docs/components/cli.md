# OpenHW Studio CLI

Terminal-first CLI for OpenHW Studio project management, headless simulation, serial monitoring, and library management.

## Install

```bash
cd openhw-studio-cli
npm install
```

## Run

```bash
npm run cli -- --help
```

## Core Commands

### Project JSON workflows

```bash
# Create a canonical project JSON
npm run cli -- project init temp/project.json --name demo --board arduino_uno

# Import project metadata embedded in PNG
npm run cli -- project import-png exports/snapshot.png -o temp/project.json

# Normalize any compatible JSON into canonical schema
npm run cli -- project import-json old-workflow.json -o temp/project.json

# Export canonical JSON to file or stdout
npm run cli -- project export-json temp/project.json -o out/project-normalized.json
npm run cli -- project export-json temp/project.json

# Show summary and validation
npm run cli -- project summary temp/project.json
npm run cli -- project validate temp/project.json
```

### Circuit editing from terminal

```bash
# Inspect known component types (from emulator manifests)
npm run cli -- project component-types

# Add parts and connect pins
npm run cli -- project add-component temp/project.json --type wokwi-led --id led1 --x 240 --y 140
npm run cli -- project add-component temp/project.json --type wokwi-servo --id servo1 --attrs-file temp/servo-attrs.json
npm run cli -- project connect temp/project.json --from board1:13 --to led1:A
npm run cli -- project connect temp/project.json --from board1:GND --to led1:C

# Update board code (inline or file)
npm run cli -- project set-code temp/project.json --board-id board1 --code-file examples/blink.ino

# Set block-coding metadata (Blockly XML + generated code preference)
npm run cli -- project set-blockly temp/project.json --xml-file temp/workspace.xml --generated-code-file temp/generated.cpp --use-blockly-code true
npm run cli -- project block-summary temp/project.json

# Update project/library.txt from a text file
npm run cli -- project set-library-file temp/project.json --input temp/libs.txt
```

### Simulation + debug visibility

```bash
# Run until Ctrl+C
npm run cli -- sim run temp/project.json --debug text

# Run for fixed duration
npm run cli -- sim run temp/project.json --duration-ms 5000 --debug json

# Select board when project has multiple boards
npm run cli -- sim run temp/project.json --board-id board2 --duration-ms 3000

# Run all boards with UART/soft-serial routing enabled
npm run cli -- sim run temp/project.json --all-boards --duration-ms 4000 --telemetry json

# Emit component behavior report
npm run cli -- sim telemetry temp/project.json --duration-ms 2500 --json

# Capture bounded runtime event trace timeline
npm run cli -- sim trace temp/project.json --duration-ms 3000 --event-types state,serial,fault --include-state

# Inspect one component in detail (state + telemetry)
npm run cli -- sim inspect temp/project.json --component-id led1 --duration-ms 2000

# Inspect by probing an interaction event first
npm run cli -- sim inspect temp/project.json --component-id ldr1 --event SET_ATTR --key lux --value 700 --at-ms 250

# Inject component events (input, SET_ATTR, press/release)
npm run cli -- sim interact temp/project.json --component-id ldr1 --event SET_ATTR --key lux --value 700

# Route analysis for UART + SoftwareSerial between boards
npm run cli -- sim check-routes temp/project.json --json

# Export static or runtime screenshot SVG
npm run cli -- sim screenshot temp/project.json --duration-ms 0 --output out/static.svg
npm run cli -- sim screenshot temp/project.json --duration-ms 1200 --output out/runtime.svg --telemetry-json out/runtime-telemetry.json

# Inspect input/output component automation templates
npm run cli -- sim capabilities temp/project.json --json

# Probe one component with diffed before/after state + pin/display behavior
npm run cli -- sim probe temp/project.json --component-id ldr1 --event SET_ATTR --key lux --value 700 --assertions-file temp/assertions.yaml

# Display-focused normalized state capture for AI agents
npm run cli -- sim display temp/project.json --duration-ms 1500 --output out/display.json

# Multi-step scenario with timed inputs and assertions
npm run cli -- sim scenario temp/project.json --scenario scenarios/sensor-check.yaml --output out/scenario-report.json

# Print simulation-focused summary and validation
npm run cli -- sim summary temp/project.json
```

### Serial monitor (hardware + simulated)

```bash
# List hardware serial ports from backend
npm run cli -- serial ports --json

# Hardware serial monitor with board/port selection
npm run cli -- serial monitor --board pico --baud 115200
npm run cli -- serial monitor --port COM7 --baud 9600

# Simulated serial monitor (stdin forwarded into simulation RX)
npm run cli -- serial sim-monitor temp/project.json --duration-ms 10000
```

### MCP server (local stdio)

```bash
# Run local MCP server over stdio
npm run cli -- mcp serve

# Optional token gate for tool calls
npm run cli -- mcp serve --auth-token local-dev-token
```

MCP tools now include `sim_execute`, `sim_trace`, `sim_inspect`, `simulation_step`, and `simulation_assert` with support for debug/GDB trace capture (`debug_mode`, `include_trace`) and simulation console capture (`include_console`) without polluting stdio transport.

Additional MCP lifecycle and diagnostics tools:
- `project_open` (set active session from an existing project file)
- `project_status` (active session state + summary)
- `project_validate` (schema/reference validation for active session)
- `component_catalog` (discover component capabilities/pins/onEvent/telemetry metadata)
- `simulation_capabilities` (project-scoped observability and interaction affordances for AI agents)
- `component_input_schema` (event templates + sensor profiles per component instance)
- `wiring_validate` (dry-run endpoint/wire validation without project mutation)

### Library management

```bash
npm run cli -- lib list
npm run cli -- lib search servo
npm run cli -- lib install "Adafruit NeoPixel"
npm run cli -- lib uninstall "Adafruit NeoPixel"
npm run cli -- lib sync-project temp/project.json --dry-run
```

### Advanced MCP testing + behavior reports

```bash
# MCP response contract coverage (positive + negative paths)
npm run test:mcp:contracts

# Validate block-coding project workflow through CLI
npm run test:cli:block-coding

# Deterministic scenario runner dry-run (YAML/JSON manifest parse + wiring diagnostics + report export)
npm run test:mcp:scenario

# Dry-run fixture coverage for display-heavy and sensor-heavy projects
npm run test:mcp:scenario:display
npm run test:mcp:scenario:sensor

# Full runtime scenario execution (requires simulation dependencies/backend)
npm run test:mcp:scenario:full

# Override scenario/report paths
node scripts/mcp-scenario-runner.mjs \
  --scenario scenarios/pico-led-lifecycle.yaml \
  --output-json temp/mcp-scenario-report.json \
  --output-md temp/mcp-scenario-report.md \
  --baseline temp/mcp-scenario-report-baseline.json
```

The scenario runner report includes:
- per-component state timeline (`trace.componentTimeline`)
- board pin activity timeline (`trace.boardPinTimeline`)
- wire/connectivity diagnostics (`wiring`)
- serial + telemetry + trace correlation (`serial`, `telemetry`, `trace`)
- optional behavior-diff gate against a baseline report (`--baseline`)

### Interactive REPL

```bash
npm run cli -- repl
```

## Notes

- `sim run` supports `--board-id` and `--all-boards` for multi-board projects.
- `serial monitor` provides hardware COM/TTY communication.
- `sim run`, `sim telemetry`, and `serial sim-monitor` provide terminal-visible simulation telemetry/debug streams.
- `sim trace` captures event timelines (state/serial/fault/debug) with optional filters.
- `sim inspect` returns focused runtime diagnostics for one component or the whole project.
- `sim screenshot` supports both static (`--duration-ms 0`) and runtime (`--duration-ms > 0`) capture to SVG.
- `sim interact` can inject component events for interactive parts (e.g. LDR, potentiometer, pushbutton).
- `mcp serve` starts a local Model Context Protocol server over stdio, including simulation trace/inspect tools for remote automation.
- Default backend URL is `http://localhost:5001/api` and can be overridden with `--backend-url`.

## MCP CLI completion checklist

- [x] Project lifecycle tools: init/open/status/validate
- [x] Component catalog/discovery with pin and capability metadata
- [x] Dry-run wiring validation diagnostics before mutation
- [x] Simulation execution, trace capture, and inspect/event injection
- [x] Scenario-driven test runner with JSON/YAML manifests
- [x] Unified report export in JSON + human-readable Markdown
- [x] Contract tests for MCP tool response shape + negative cases
- [x] Pico component matrix scripts for broad and per-component coverage


