# Arduino Simulator — OpenHW Studio

A full-stack browser-based Arduino simulator built on top of **avr8js** and **Wokwi web components**. Write Arduino C++ code, design circuits visually, and watch them simulate in real time — all in the browser.

---

## Architecture

This monorepo contains three packages that work together:

```
Arduino-simulator/
├── OpenHW-studio-frontend-danish/   # React + Vite web app (Hub, User & Admin UI)
├── openhw-studio-backend-danish/    # Express.js REST API (Compiler & Asset Registry)
└── openhw-studio-emulator-danish/   # Node.js Emulator & Circuit Validation Engine
```

```
Browser (React UI)
      │
      ├── POST /api/compile ──► Backend (port 5000)
      │                               │
      │                        arduino-cli compiles
      │                         C++ → .hex file
      │                               │
      └── Circuit Validation ──► HALT if unsafe
                                      │
      └── Web Worker START + .hex ──► Emulator (port 8085)
                                            │
                                     Runs AVR CPU at 16MHz
                                     Streams pin states @ 60 FPS
                                            │
                                  Frontend updates LED/NeoPixel UI
```

---

## Packages

### 🎨 Frontend — `OpenHW-studio-frontend-danish/`
React 18 + Vite single-page app. Provides the circuit editor canvas, Arduino code editor, and real-time simulation rendering via Wokwi web components.

- **Port:** `http://localhost:5173`
- **Key libs:** React Router, Axios, avr8js, intel-hex, Prism.js, react-simple-code-editor

### 🖥️ Backend — `openhw-studio-backend-danish/`
Express.js REST API. Accepts C++ code, invokes `arduino-cli` to compile it, and returns the `.hex` output. Also handles user auth (JWT + bcrypt) and MongoDB data.

- **Port:** `http://localhost:5000`
- **Key libs:** Express, Mongoose, jsonwebtoken, bcryptjs, cors

### ⚙️ Emulator — `openhw-studio-emulator-danish/`
High-speed WebSocket server. Runs a virtual ATmega328P (Arduino Uno chip) at a simulated 16 MHz, utilizing `avr8js` **AVRIOPort** infrastructure natively for 100% accurate Hardware Interrupts (EXTI/PCINT) and Internal Pull-up Resistor simulation. Decodes WS2812B NeoPixel signals, routes I2C (TWI) and SPI peripheral buses, and streams JSON state at ~60 FPS.

- **Port:** `ws://localhost:8085`
- **Key libs:** ws, avr8js, intel-hex

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

---

- **Circuit Validation Engine**: Pre-simulation safety check that traces wiring graphs to detect errors (e.g., missing resistors for LEDs) before the CPU starts.
- **Admin Dashboard**: A dedicated administrative portal to manage libraries and review community component submissions via a 3-column layout.
- **Zero-Touch Component Sync**: Custom components submitted by users can be reviewed, tested in-browser, and approved by admins with instant synchronization.
- **In-Browser Transpilation**: Leverage Babel Standalone to transpile and execute custom component UI (React) and Logic (TypeScript) code directly in the browser memory for instant previews.

---

## Setup & Running

Because the frontend, backend, and emulator are now decoupled, you must install dependencies for each individually.

### Prerequisites
- **Node.js 18+** and **npm 9+**
- **MongoDB** running locally (or Atlas URI)
- **arduino-cli** installed and `arduino:avr` core installed:
  ```bash
  arduino-cli core install arduino:avr
  ```

### Install Dependencies
Run `npm install` inside each of the three directories:
```bash
# 1. Install Frontend Dependencies
cd OpenHW-studio-frontend-danish
npm install
cd ..

# 2. Install Backend Dependencies
cd openhw-studio-backend-danish
npm install
cd ..

# 3. Install Emulator Dependencies
cd openhw-studio-emulator-danish
npm install
cd ..
```

### Local Development & NPM Linking
During local development, you will want the frontend to immediately see changes you make to the emulator source code, without having to push those changes to GitHub first.

We achieve this using **NPM Symlinks**, which tell the frontend to use the local `openhw-studio-emulator-danish` folder instead of downloading the cached version from GitHub.

To set up your local development links:
```bash
# 1. Register the emulator as a linkable global package
cd openhw-studio-emulator-danish
npm link
cd ..

# 2. Tell the frontend to use the linked local emulator
cd OpenHW-studio-frontend-danish
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
cd openhw-studio-backend-danish
npm run dev

# Terminal 2 — Emulator
cd openhw-studio-emulator-danish
node src/server.js

# Terminal 3 — Frontend
cd OpenHW-studio-frontend-danish
npm run dev
```

Then open **http://localhost:5173** in your browser.

### Environment Variables
Create a file named `.env` inside `openhw-studio-backend-danish/`:
```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/openhw-studio
JWT_SECRET=your_secret_key_here
```

---
## Credit 
KrishnaManohar101 (for initial codebase)

## License
MIT
