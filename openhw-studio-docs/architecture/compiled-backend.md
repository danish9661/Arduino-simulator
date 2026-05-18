# [BOARD] OpenHW-Studio: Compiler Backend Architecture

> **Role:** Orchestrates the high-performance, isolated compilation of Arduino C++ sketches into machine-level `.hex`/`.uf2` binaries, manages virtual filesystem bundling for MicroPython/CircuitPython, and operates a robust, weighted concurrency queue with a 1 GB partitioned library storage manager.

---

## 🖥️ 1. Server Hardware Sizing & Memory Budget

The Compiler Backend is specifically engineered to operate flawlessly on a **4 vCPU / 8 GB RAM** Ubuntu Virtual Machine. To prevent Out-Of-Memory (OOM) kernel crashes (Exit Code 137) and CPU thrashing during peak classroom usage, the system enforces a strict memory budget:

```
[ Total Server RAM: 8 GB ]
  ├── System Reservation (3 GB): Ubuntu OS, Express API, MongoDB, Frontend, Docs Server
  └── Compiler Worker Pool (5 GB): Dedicated entirely to active compilation jobs
```

By reserving 3 GB for core system services, the remaining **5 GB RAM** is safely allocated to the in-memory compilation queue, guaranteeing zero server crashes even when hundreds of students submit code simultaneously.

---

## ⚙️ 2. Weighted Concurrency Queue

Because compiling 32-bit ARM C++ for the Raspberry Pi Pico consumes significantly more RAM and CPU threads than compiling 8-bit AVR C++ for the Arduino Uno, a simple FIFO queue is inadequate. The backend implements an in-memory **Weighted Concurrency Queue** (`fastq` / `async.queue`).

### Queue Capacity & Point System
The 5 GB compiler memory pool is translated into a maximum queue capacity of **7 Concurrency Slots (700 Points)**.

| Target / Builder | Slot Weight | Max Concurrent Jobs | Resource Footprint & Throttling |
|---|---|---|---|
| **Arduino Uno (`arduino:avr:uno`)** | **1 Slot (100 pts)** | 7 simultaneous jobs | ~100 MB RAM. Single-threaded AVR GCC execution. |
| **Pico (`rp2040:rp2040` / `pico-sdk`)** | **2 Slots (200 pts)** | 3 simultaneous jobs | ~300–500 MB RAM. Throttled to `ninja -j 2` (2 CPU threads each). |
| **MicroPython / CircuitPython** | **1 Slot (100 pts)** | 7 simultaneous jobs | ~50 MB RAM. Fast virtual filesystem packing (no C++ compilation). |

### The 5 Core Queue Rules
1. **Weighted Admission:** When a job arrives, the queue evaluates the sum of currently active job weights. If `Active Points + New Job Points <= 700`, the job executes instantly. If a Pico job (200 pts) arrives while 600 pts are active, it waits asynchronously until a slot frees up.
2. **Request Deduplication (Locking):** If multiple students submit the exact same sketch code and library configuration while an identical compilation is already running or queued, the queue attaches the new requests to the existing job. Only **1 compilation** executes on the CPU, and the resulting binary is broadcast to all attached clients simultaneously.
3. **Strict 30-Second Timeout:** Any C++ compilation job that exceeds 30 seconds is forcefully terminated (`SIGKILL`). This prevents malformed C++ templates or infinite loops from permanently locking up worker threads and CPU cores.
4. **CPU Core Throttling:** All Pico-SDK `cmake` builds are explicitly forced to execute with `ninja -j 2`. This guarantees that a single Pico build cannot consume more than 2 vCPUs, leaving the remaining cores responsive for Express API routing and other worker jobs.
5. **Priority Scheduling:** Live interactive "Run" clicks from classroom users are assigned High Priority. Automated background grading tasks or library pre-warming jobs are assigned Low Priority.

---

## 🏛️ 3. Isolated Compilation Engine (`library.txt`)

To allow different users (or a single user simulating multiple boards) to compile with different versions of the same library simultaneously without conflict, the backend enforces **100% Isolated Compilation**.

```
/app/data/libraries/cache/
 ├── cpp/
 │    ├── ArduinoJson/6.21.3/
 │    └── ArduinoJson/7.0.0/
 └── micropython/
      └── micropython-adafruit-neopixel/1.0.0/

/app/temp/compile-workspaces/
 ├── job_uno_user1/
 │    ├── sketch.ino
 │    └── isolated_libs/ ──(Symlink)──> ../../../data/libraries/cache/cpp/ArduinoJson/6.21.3
 └── job_pico_user2/
      ├── CMakeLists.txt
      └── isolated_libs/ ──(Symlink)──> ../../../data/libraries/cache/cpp/ArduinoJson/7.0.0
```

### `library.txt` Syntax & Fallback
Inside each board's project directory, users (or the UI Library Manager) maintain a `library.txt` file listing required dependencies.
* **Syntax:** `name@version` (e.g., `ArduinoJson@6.21.3`).
* **Fallback:** If the user specifies a library without `@version` (e.g., `LiquidCrystal I2C`), the backend inspects the cached library index and automatically resolves and fetches the latest stable release.

### Runtime Differentiation: C++ vs. Python
How does the backend know whether a library in `library.txt` is for C++ or Python?
* Every compilation request sent to `POST /api/compile` explicitly includes the `builder` parameter (`arduino-cli`, `pico-sdk`, `micropython`, `circuitpython`).
* **If C++ (`arduino-cli` / `pico-sdk`):** The worker knows all entries in `library.txt` are C++ libraries. It queries the cached Arduino Library Index (`library_index.json`) and pulls from `/app/data/libraries/cache/cpp/`.
* **If Python (`micropython` / `circuitpython`):** The worker knows all entries in `library.txt` are Python libraries. It queries the cached Python bundle index and pulls from `/app/data/libraries/cache/micropython/` or `circuitpython/`.

### Isolation Mechanics per Target
* **Arduino Uno & Arduino-Pico (`arduino-cli`):** The worker creates a unique, temporary compile workspace in `temp/compile-workspaces/<job_id>/`. Inside it, it creates an `isolated_libs/` directory containing symbolic links (symlinks) to the exact library version folders requested from the storage pools. It invokes `arduino-cli compile --libraries ./isolated_libs`. `arduino-cli` is strictly isolated to those linked versions.
* **Pico-SDK (`cmake` / `ninja`):** `arduino-cli` flags do not apply to CMake. To support any C/C++ library without requiring custom CMake configs, the worker symlinks the library folders into `isolated_libs/`. It then dynamically injects the following into `CMakeLists.txt`:
  ```cmake
  file(GLOB_RECURSE LIB_SOURCES "isolated_libs/*.cpp" "isolated_libs/*.c")
  add_executable(firmware ${SOURCES} ${LIB_SOURCES})
  target_include_directories(firmware PRIVATE isolated_libs/LibraryA isolated_libs/LibraryB)
  ```
  This ensures seamless, isolated compilation for any standard C/C++ library.
* **MicroPython & CircuitPython:** Python simulations do not require C++ compilation. The backend serves the pre-compiled base MicroPython/CircuitPython UF2 firmware. For user scripts (`main.py`) and external `.py` libraries listed in `library.txt`, the worker fetches the `.py` files from the cache pool and bundles them into a board-specific LittleFS or FAT virtual filesystem image. This image is sent to the frontend emulator, guaranteeing isolated execution with zero global environment conflicts.

---

## 📦 4. 1 GB Partitioned Library Storage Manager

To prevent disk bloat while ensuring high-speed compilation, the backend allocates exactly **1 GB of disk space** to library storage. This quota is divided into two 512 MB pools, each internally partitioned by runtime (`cpp`, `micropython`, `circuitpython`).

```
[ Total 1 GB Disk Quota ]
  ├── Pool A: 512 MB Pre-installed Official Pool (Persistent, Read-Only for Workers)
  └── Pool B: 512 MB Dynamic LRU Cache (Ephemeral, Auto-Pruning)
```

### Pool A: 512 MB Pre-installed Official Pool
* **Location:** `/app/data/libraries/official/`
* **Contents:** Heavily utilized, standard classroom libraries (`Servo`, `Wire`, `LiquidCrystal I2C`, `Adafruit GFX`, `DHT`, etc.) pre-downloaded in their most stable versions.
* **Management:** Read-only for compiler workers. It is never deleted or pruned by the queue. It is populated at boot via a static `libraries.json` manifest and can be expanded dynamically by administrators via `POST /api/admin/lib-install`.

### Pool B: 512 MB Dynamic LRU Cache
* **Location:** `/app/data/libraries/cache/`
* **Contents:** Ephemeral storage for libraries requested dynamically by users in `library.txt` that are not present in Pool A. 
* **Direct ZIP Unzipping (Bypassing CLI Overhead):** Instead of executing `arduino-cli lib install` (which incurs heavy CLI startup and dependency checking overhead), the storage manager performs a direct Node.js `fetch()` of the library ZIP from the Arduino CDN or GitHub Releases. It unzips the file directly into `cache/cpp/<name>/<version>/` using `adm-zip`. This completes in under 1 second.
* **LRU (Least Recently Used) Auto-Pruning Rules:**
  1. Every time a compilation job uses a library from Pool B, the storage manager updates that library folder's `lastAccessed` timestamp (`fs.utimesSync`).
  2. After any new library ZIP is downloaded and extracted, the manager verifies the total disk size of Pool B.
  3. If `Total Size > 512 MB`, the manager deletes the oldest, least-recently-accessed library version folders until the pool size is reduced to **400 MB**. This guarantees a clean 112 MB buffer for incoming classroom requests.

### Daily Index Caching
To enable instant ZIP URL resolution without querying external APIs during compilation, the backend downloads and caches the official Arduino `library_index.json` and Python bundle indexes once every 24 hours in the background.

---
*Architectural blueprint established for OpenHW Studio High-Performance Compiler Backend.*
