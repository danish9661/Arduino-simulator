# Arduino Simulator — OpenHW Studio

A full-stack browser-based Arduino simulator built on top of **avr8js** and **Wokwi web components**. Write Arduino C++ code, design circuits visually, and watch them simulate in real time — all in the browser.

---

## Architecture

This monorepo contains three packages that work together:

```
Arduino-simulator/
├── OpenHW-studio-frontend-danish/   # React + Vite web app (UI)
├── openhw-studio-backend-danish/    # Express.js REST API (compiler)
└── openhw-studio-emulator-danish/   # Node.js WebSocket server (CPU emulator)
```

```
Browser (React UI)
      │
      ├── POST /api/compile ──► Backend (port 5000)
      │                               │
      │                        arduino-cli compiles
      │                         C++ → .hex file
      │                               │
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

## Powerful Integrated Tools

- **Serial Monitor**: Talk directly to the virtual UART port natively in the browser. 
- **Analog Plotter / Logic Analyzer**: Trace real-time multi-pin voltage signals using a highly-optimized, zero-dependency HTML5 `<canvas>` rendering engine.
- **Physical Controls**: Click the physical Reset button on the Arduino Uno graphic to reboot the active web-worker sketch loop.
- **Advanced Bus Routing**: I2C and SPI peripheral mapping allows standard Arduino libraries to work immediately natively.

---

## Setup & Running

### Prerequisites
- **Node.js 18+** and **npm 9+**
- **MongoDB** running locally (or Atlas URI)
- **arduino-cli** installed and `arduino:avr` core installed:
  ```bash
  arduino-cli core install arduino:avr
  ```

### Install all dependencies
```bash
npm install
```

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
Create a file named `env` inside `openhw-studio-backend-danish/`:
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
