#!/usr/bin/env node
// Usage: node dump_vram_to_png.js <telemetry.json> <componentId> [out.png]
// Requires: npm install pngjs

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

if (process.argv.length < 4) {
  console.error('Usage: node dump_vram_to_png.js <telemetry.json> <componentId> [out.png]');
  process.exit(2);
}

const telemetryPath = process.argv[2];
const compId = process.argv[3];
const outPath = process.argv[4] || `${compId}.png`;

const raw = fs.readFileSync(telemetryPath, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('Failed to parse JSON:', e.message);
  process.exit(2);
}

// Support both arrays and top-level objects with samples
let samples = Array.isArray(data) ? data : (data.samples || []);
if (!Array.isArray(samples)) samples = [];

let lastState = null;
for (const s of samples) {
  const details = s.details || s["details"] || s["state"];
  if (!details) continue;
  if (details.id === compId && details.state && details.state.buffer) {
    lastState = details.state;
  }
}

if (!lastState) {
  // Try scanning more broadly if file is structured differently
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.id === compId && obj.state && obj.state.buffer) return obj.state;
    for (const k of Object.keys(obj)) {
      const res = walk(obj[k]);
      if (res) return res;
    }
    return null;
  }
  lastState = walk(data);
}

if (!lastState || !lastState.buffer) {
  console.error('Could not find buffer for component', compId);
  process.exit(2);
}

const bufObj = lastState.buffer;
// Build Uint8Array
const WIDTH = lastState.width || 240;
const HEIGHT = lastState.height || 320;
const expected = WIDTH * HEIGHT * 3;
const vram = Buffer.alloc(expected);
for (let i = 0; i < expected; i++) {
  const k = String(i);
  vram[i] = (bufObj[k] !== undefined) ? bufObj[k] : 0;
}

const png = new PNG({ width: WIDTH, height: HEIGHT });
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const pi = (y * WIDTH + x);
    const vi = pi * 3;
    const ri = pi * 4;
    png.data[ri] = vram[vi];
    png.data[ri + 1] = vram[vi + 1];
    png.data[ri + 2] = vram[vi + 2];
    png.data[ri + 3] = 255;
  }
}

png.pack().pipe(fs.createWriteStream(outPath)).on('finish', () => {
  console.log('Wrote', outPath);
});
