const fs = require('fs');
const path = require('path');

const picoDir = path.join(__dirname, 'openhw-studio-emulator', 'src', 'components', 'openhw-pico');
const picoWDir = path.join(__dirname, 'openhw-studio-emulator', 'src', 'components', 'openhw-pico-w');

function inlineSvg(dir, prefix) {
    const uiFile = path.join(dir, 'ui.tsx');
    const svgFile = path.join(dir, `${prefix}.svg.html`);
    
    if (fs.existsSync(uiFile) && fs.existsSync(svgFile)) {
        let uiContent = fs.readFileSync(uiFile, 'utf8');
        let svgContent = fs.readFileSync(svgFile, 'utf8');
        
        // Remove node:fs import
        uiContent = uiContent.replace(/import fs from 'node:fs';\r?\n?/g, '');
        
        // Replace the try...catch with the inline string
        let regex = /let (?:pico|picow)SvgMarkup\s*=\s*'';\s*try\s*\{[\s\S]*?catch\s*\([^)]*\)\s*\{[\s\S]*?\}/;
        
        let newContent = `const ${prefix.replace('-', '')}SvgMarkup = \`${svgContent.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`;`;
        if (prefix === 'pico-w') {
             newContent = `const picowSvgMarkup = \`${svgContent.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`;`;
        }
        
        uiContent = uiContent.replace(regex, newContent);
        
        fs.writeFileSync(uiFile, uiContent);
        console.log(`Inlined SVG in ${uiFile}`);
    }
}

inlineSvg(picoDir, 'pico');
inlineSvg(picoWDir, 'pico-w');
