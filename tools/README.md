Dump tools

dump_vram_to_png.js

Usage:

1. Install dependency:

```bash
npm install pngjs
```

2. Run:

```bash
node tools/dump_vram_to_png.js <telemetry.json> <componentId> [out.png]
```

Example:

```bash
node tools/dump_vram_to_png.js simulation-telemetry-protocol-2026-05-25T18-46-41-961Z.json ili9341_1 ili9341.png
```
