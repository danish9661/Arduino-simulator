const fs = require('fs');
const path = require('path');

const picoWDir = path.join(__dirname, 'openhw-studio-emulator', 'src', 'components', 'openhw-pico-w');
const svgFile = path.join(__dirname, 'openhw-studio-emulator', 'src', 'components', 'openhw-pico', 'pico.svg.html');

const uiFile = path.join(picoWDir, 'ui.tsx');

let uiContent = fs.readFileSync(uiFile, 'utf8');
let svgContent = fs.readFileSync(svgFile, 'utf8');

// Remove node:fs import
uiContent = uiContent.replace(/import fs from 'node:fs';\r?\n?/g, '');

// Replace the try...catch with the inline string
let regex = /let picoSvgMarkup\s*=\s*'';\s*try\s*\{[\s\S]*?catch\s*\([^)]*\)\s*\{[\s\S]*?\}/;

let newContent = `const picoSvgMarkup = \`${svgContent.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`;`;

uiContent = uiContent.replace(regex, newContent);

fs.writeFileSync(uiFile, uiContent);
console.log(`Inlined SVG in ${uiFile}`);
