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
