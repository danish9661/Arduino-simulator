# Arduino Simulator — OpenHW Studio

A full-stack browser-based Arduino simulator built on top of **avr8js** and **Wokwi web components**. Write Arduino C++ code, design circuits visually, and watch them simulate in real time — all in the browser.

---

## Architecture

This monorepo contains four packages that work together:

```
Arduino-simulator/
├── OpenHW-studio-frontend/   # React + Vite web app (Hub, User & Admin UI)
├── openhw-studio-backend/    # Express.js REST API (Compiler & Asset Registry)
├── openhw-studio-emulator/   # Node.js Emulator & Circuit Validation Engine
└── openhw-studio-cli/        # Terminal CLI (project/sim/serial/lib workflows)
```

```
Browser (React UI)
      │
      ├── POST /api/compile ──► Backend (port 5001)
      │                               │
      │                        arduino-cli compiles
      │                         C++ → .hex file
      │                               │
      └── Circuit Validation ──► HALT if unsafe
                                      │
      └── Web Worker START + .hex ──► Emulator (in-browser Web Worker)
                                            │
                                     Runs AVR CPU at 16MHz
                                     Streams pin states @ 60 FPS
                                            │
                                  Frontend updates LED/NeoPixel UI
```

---

## Packages

### Frontend — `OpenHW-studio-frontend/`
React 18 + Vite single-page app. Provides the circuit editor canvas, Arduino code editor, and real-time simulation rendering via Wokwi web components.

- **Port:** `http://localhost:5173`
- **Key libs:** React Router, Axios, avr8js, intel-hex, Prism.js, react-simple-code-editor, JSZip, Babel Standalone

### Backend — `openhw-studio-backend/`
Express.js REST API. Accepts C++ code, invokes `arduino-cli` to compile it, and returns the `.hex` output. Also handles user auth (JWT + Passport Google OAuth) and MongoDB data.

- **Port:** `http://localhost:5001`
- **Key libs:** Express, Mongoose, jsonwebtoken, Passport, bcryptjs, cors

### Emulator — `openhw-studio-emulator/`
Shared component definitions library and AVR simulation engine (runs as a Web Worker inside the browser). Exports all component manifests, UI renderers, and logic classes consumed by the frontend.

- **Key libs:** avr8js, intel-hex, TypeScript

### CLI — `openhw-studio-cli/`
Node.js terminal tooling for JSON import/export, project editing, simulation control, serial monitoring, and backend library management.

- **Key libs:** Commander, SerialPort, TypeScript/tsx

---

## Supported Components

| Component | Type |
|---|---|
| Arduino Uno | Microcontroller |
| LED | Digital output |
| Resistor | Passive |
| Push Button | Digital input |
| Power Supply | Power rail |
| Buzzer | Digital output |
| DC Motor | Output |
| L298N Motor Driver | Output |
| Servo Motor | PWM output |
| Potentiometer | Analog input |
| Slide Potentiometer | Analog input |
| NeoPixel Matrix (WS2812B) | Addressable RGB LED |
| Shift Register (74HC595) | Digital output expander |

---

## Key Features

- **Circuit Validation Engine**: Pre-simulation safety check that traces wiring graphs to detect errors (e.g., missing resistors for LEDs) before the CPU starts.
- **Admin Dashboard**: A dedicated administrative portal to manage libraries and review community component submissions via a 3-column layout.
- **Zero-Touch Component Sync**: Custom components submitted by users can be reviewed, tested in-browser, and approved by admins with instant synchronization.
- **In-Browser Transpilation**: Leverage Babel Standalone to transpile and execute custom component UI (React) and Logic (TypeScript) code directly in browser memory for instant previews.
- **Advanced Workspace**: Features a resizable file explorer, protected system files (`diagram.json`), and live serial monitor.

### March 2026 Updates

- **Pico dual-source workflow**: RP2040 board folders now include both `<boardId>.ino` and `main.py` starter files.
- **Per-file enable/disable**: Code files can be toggled from the explorer context menu by appending/removing `.disabled`.
- **Refresh stability**: Persisted project files are normalized on load to prevent duplicate file rows after page refresh.
- **Blockly dev-noise reduction**: Custom block registration now skips already-defined types, avoiding overwrite warnings in React StrictMode.

### Offline-First & Local Storage Features

All four features below work without an internet connection and require no backend changes.

| Feature | Description |
|---|---|
| **WASM Offline Compilation** | Compile C++ code locally in the browser using a WASM-based compiler, completely eliminating the need for the backend API once the toolchain is downloaded and cached in IndexedDB. |
| **Compiled Hex Cache** | Compiled `.hex` results are persisted to IndexedDB. On re-run (after page refresh or offline), the cached hex is used directly — no recompilation needed. Up to 50 entries with LRU eviction. |
| **Offline ZIP Upload Queue** | Custom component ZIPs uploaded while offline are queued in IndexedDB and auto-submitted to the backend when the internet is restored. The component is injected locally and immediately usable during the session. |
| **Service Worker** | A registered Service Worker caches the app shell (HTML/JS/CSS) and static assets. The simulator loads and works even when the backend is unreachable. API calls are never intercepted. |
| **Project Storage (IndexedDB)** | Full circuit state (components, wires, code, board) is auto-saved to IndexedDB every 2.5 seconds. Works for **both guests and authenticated users**. Returning visitors automatically get their last project restored. The "My Projects" modal lets users manage named saves. |

For a full technical deep-dive, see **[OFFLINE_AND_STORAGE.md](./OFFLINE_AND_STORAGE.md)**.

---

## Setup & Running

Because the frontend, backend, and emulator are now decoupled, you must install dependencies for each individually.

### Prerequisites
- **Node.js 18+** and **npm 9+**
- **MongoDB** running locally (or Atlas URI)
- **arduino-cli** installed with AVR and RP2040 cores:
  ```bash
  arduino-cli config add board_manager.additional_urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
  arduino-cli core update-index
  arduino-cli core install arduino:avr
  arduino-cli core install rp2040:rp2040
  ```

### Install Dependencies
Run `npm install` inside each package directory:
```bash
# 1. Install Frontend Dependencies
cd OpenHW-studio-frontend
npm install
cd ..

# 2. Install Backend Dependencies
cd openhw-studio-backend
npm install
cd ..

# 3. Install Emulator Dependencies
cd openhw-studio-emulator
npm install
cd ..

# 4. Install CLI Dependencies
cd openhw-studio-cli
npm install
cd ..
```

### CLI Quick Start

```bash
cd openhw-studio-cli
npm run cli -- --help

# Example: create a project, validate, and run simulation
npm run cli -- project init temp/demo.json --name demo --board arduino_uno
npm run cli -- project validate temp/demo.json
npm run cli -- sim run temp/demo.json --duration-ms 3000 --debug text
```

### Local Development & NPM Linking
During local development, you will want the frontend to immediately see changes you make to the emulator source code, without having to push those changes to GitHub first.

We achieve this using **NPM Symlinks**, which tell the frontend to use the local `openhw-studio-emulator` folder instead of downloading the cached version from GitHub.

To set up your local development links:
```bash
# 1. Register the emulator as a linkable global package
cd openhw-studio-emulator
npm link
cd ..

# 2. Tell the frontend to use the linked local emulator
cd OpenHW-studio-frontend
npm link @openhw/emulator
cd ..
```
*Note: Once deployed to Vercel/Netlify, these local symlinks will be ignored and the remote server will correctly fetch the package directly from GitHub.*

### Start all servers

**Option A — One command (opens separate windows):**
```bat
start_all.bat
```

**Option B — Manual (three separate terminals):**

```bash
# Terminal 1 — Backend
cd openhw-studio-backend
npm run dev

# Terminal 2 — Emulator
cd openhw-studio-emulator
node src/server.js

# Terminal 3 — Frontend
cd OpenHW-studio-frontend
npm run dev
```

Then open **http://localhost:5173** in your browser.

### Environment Variables
Create a file named `.env` (or `env`) inside `openhw-studio-backend/`:
```env
PORT=5001
MONGO_URI=mongodb://localhost:27017/openhw-studio
JWT_SECRET=your_secret_key_here
SESSION_SECRET=your_session_secret_here
FRONTEND_URL=http://localhost:5173
```

---

## Documentation

| Document | Description |
|---|---|
| This file | Architecture overview, setup, and feature summary |
| [OFFLINE_AND_STORAGE.md](./OFFLINE_AND_STORAGE.md) | Full technical reference for offline features and IndexedDB storage |
| [OpenHW-studio-frontend/README.md](./OpenHW-studio-frontend/README.md) | Frontend structure, pages, and features |
| [openhw-studio-backend/README.md](./openhw-studio-backend/README.md) | Backend API endpoints and compilation pipeline |
| [openhw-studio-emulator/README.md](./openhw-studio-emulator/README.md) | Emulator CPU simulation and WebSocket protocol |
| [openhw-studio-cli/README.md](./openhw-studio-cli/README.md) | Terminal command reference for project/sim/serial/lib workflows |

---

## Credit
KrishnaManohar101 (for initial codebase)

## License
MIT
