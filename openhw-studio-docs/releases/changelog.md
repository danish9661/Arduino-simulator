# Project Change Log & Session History

This file tracks all modifications made by Antigravity to ensure transparency and ease of restoration.

## [2026-05-08] Establishing Protocol
- **Action**: Created `operational_protocol` in Knowledge Base.
- **Reason**: To mandate planning and approval after an accidental global revert deleted uncommitted progress.
- **Files Modified**: 
  - `C:\Users\Danish\.gemini\antigravity\knowledge\operational_protocol.md` (Created)
  - `C:\Users\Danish\.gemini\antigravity\knowledge\operational_protocol\metadata.json` (Created)
  - `C:\Users\Danish\.gemini\antigravity\knowledge\operational_protocol\artifacts\protocol.md` (Created)

## [2026-05-08] Fix: PNG Export Color Parsing Error
- **Action**: Added a CSS color sanitization pass to the `html2canvas` `onclone` callback.
- **Reason**: `html2canvas` was crashing with "unsupported color function color()" when encountering modern CSS color formats (like `display-p3`).
- **Files Modified**: 
  - `src/pages/simulationpage/SimulatorPage.jsx`: Injected traversal logic to replace `color()` strings with a `#777` fallback during cloning.

## [2026-05-10] Implementation: Unified Telegram Health & Notification System
- **Action**: Created a standalone `health-agent` service and unified Telegram alerting across all repositories.
- **Reason**: To provide real-time monitoring, instant failure alerts, and beautiful hourly HTML reports directly to the maintainer.
- **Components Created**:
  - `openhw-studio-health-agent/`: Core monitoring logic and rich HTML reporting template.
- **Files Modified**:
  - `docker-compose.prod.yml`: Added health-agent with read-only system mounts.
  - `.github/workflows/`: Updated Frontend, Backend, Emulator, and Examples to send instant PR/Merge notifications to Telegram.
  - `deployment_guide.md`: Added Phase 7 for Telegram Bot setup and hardening.


