# Implementation Plan - Isolated Compilation, Weighted Queue & Library Manager

This document defines the architectural blueprint and implementation plan for upgrading the OpenHW Studio compiler backend. The goal is to establish a robust, crash-proof compilation engine supporting isolated library versioning, a weighted concurrency queue for a 4 vCPU / 8 GB RAM server (reserving 3 GB for system services), a 1 GB partitioned library storage manager, and unified MicroPython/CircuitPython filesystem bundling.

## Problem Statement & Background

Currently, the compiler backend (`openhw-studio-backend`) executes `arduino-cli` and `cmake` directly via `child_process.execFile` without concurrency limits. This exposes the 4 vCPU / 8 GB RAM Ubuntu VM to Out-Of-Memory (OOM) crashes and CPU freezing during peak classroom usage. Furthermore, global library installation prevents users from simulating different boards with different versions of the same library simultaneously.

## Proposed Architecture

### 1. Isolated Compilation Engine (`library.txt`)
Users specify required libraries and exact versions in a `library.txt` file located inside each board's directory (e.g., `ArduinoJson@6.21.3`).
*   **Syntax & Fallback:** Format is `name@version`. If `@version` is omitted, the backend automatically resolves and fetches the latest stable release from the cached index.
*   **Runtime Differentiation (C++ vs Python):** The compilation request explicitly includes the `builder` target (`arduino-cli`, `pico-sdk`, `micropython`, `circuitpython`).
    *   If `builder` is C++ (`arduino-cli` / `pico-sdk`), the worker pulls from the C++ library index and cache.
    *   If `builder` is Python (`micropython` / `circuitpython`), the worker pulls from the Python library index/bundle and cache.
*   **Uno / Arduino-Pico (`arduino-cli`):** The backend creates a per-job `isolated_libs/` directory inside `temp/compile-workspaces/<job_id>/`. It symlinks the exact C++ library version folders from the storage pools and invokes `arduino-cli compile --libraries ./isolated_libs`.
*   **Pico-SDK (`cmake` / `ninja`):** The backend scans `isolated_libs/` and dynamically configures `CMakeLists.txt` to include library headers and source files using `file(GLOB_RECURSE ...)` and `target_include_directories()`.
*   **MicroPython & CircuitPython:** Python libraries (`.py`/`.mpy`) are specified in the same `library.txt`. The backend worker fetches the requested `.py` files from the Python library cache pool and bundles them alongside the user's `main.py` into a board-specific LittleFS/FAT virtual filesystem image. This guarantees 100% isolation with zero conflicts.

### 2. Weighted Concurrency Queue (4 vCPU / 8 GB RAM)
To protect the server from OOM crashes (Exit Code 137) while maximizing throughput, an in-memory weighted concurrency queue (`fastq` or `async.queue`) will manage all compilation jobs.
*   **Total Server RAM Allocation:** Reserving 3 GB RAM for Ubuntu OS, Express, MongoDB, Frontend, and Docs server. This leaves **5 GB RAM** dedicated entirely to compiler workers.
*   **Total Queue Capacity:** 7 Concurrency Slots (700 Points).
*   **Uno (AVR) Weight:** 1 Slot (100 pts). (Max 7 concurrent).
*   **Pico (C++ / CMake) Weight:** 2 Slots (200 pts). Throttled to `ninja -j 2` (2 CPU threads each). (Max 3 concurrent).
*   **MicroPython / CircuitPython Weight:** 1 Slot (100 pts). (Max 7 concurrent).
*   **Queue Rules:**
    1.  *Weighted Admission:* Jobs execute instantly if active weight sum $\le 700$ pts; otherwise, they queue asynchronously.
    2.  *Deduplication (Locking):* Identical incoming requests attach to the running job; only 1 compile executes, broadcasting the result to all attached clients.
    3.  *Strict Timeout:* Jobs exceeding 30 seconds are forcefully killed (`SIGKILL`).

### 3. 1 GB Partitioned Library Storage Manager
The 1 GB disk allocation is split into two distinct pools, each internally partitioned by runtime (`cpp`, `micropython`, `circuitpython`):
*   **Pool A: 512 MB Pre-installed Official Pool (`/app/data/libraries/official`):** Persistent, read-only pool for workers containing standard classroom libraries (`Servo`, `Wire`, `LiquidCrystal I2C`, `DHT`). Updated via Admin API or boot manifest.
*   **Pool B: 512 MB Dynamic LRU Cache (`/app/data/libraries/cache`):** Ephemeral pool storing libraries unzipped directly from Arduino CDN/GitHub ZIP releases or Python bundles. 
*   **LRU Pruning Rule:** Each library usage updates its `lastAccessed` timestamp (`fs.utimesSync`). If Pool B exceeds 512 MB after a new download, the oldest folders are deleted until the pool reaches 400 MB.
*   **Library Index Caching:** The backend downloads and caches `library_index.json` (C++) and Python bundle indexes once every 24 hours to resolve ZIP URLs instantly.

---

## Proposed Changes

### Documentation Repository (`openhw-studio-docs`)

#### [MODIFY] [compiler-backend.md](file:///c:/Users/Danish/Documents/simulator/openhw-studio-docs/architecture/compiler-backend.md)
Update the existing architectural documentation to reflect the upgraded backend design with exhaustive, inch-by-inch explanations.
*   Add comprehensive sections detailing the **Isolated Compilation Pipeline** using per-board `library.txt` symlinking and runtime differentiation.
*   Document the **Weighted Concurrency Queue** point system (700 pts max), worker limits, deduplication locking, and 30-second timeout rules for the 4 vCPU / 8 GB RAM VM (reserving 3 GB for system services).
*   Document the **1 GB Partitioned Library Storage Manager** (512 MB Official Read-Only Pool + 512 MB Dynamic LRU Cache Pool), runtime sub-folders (`cpp`, `micropython`, `circuitpython`), and direct ZIP unzipping mechanism.
*   Document the **MicroPython & CircuitPython Virtual Filesystem Bundling** architecture.

---

## Verification Plan

### Manual Verification
1.  Verify the markdown formatting and structural clarity of `compiler-backend.md` in `openhw-studio-docs`.
2.  Ensure all user requirements (3 GB RAM reservation, 5 GB compiler pool, 1 GB library split, `library.txt` versioning, Pico CMake linking, MicroPython bundling) are fully and rigorously documented.
