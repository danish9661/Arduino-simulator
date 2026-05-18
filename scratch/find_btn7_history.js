const fs = require('fs');

const logPath = 'C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-2026-05-18T14-04-56-052Z.log';
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

const btn7Lines = lines.filter(l => l.includes('btn7'));
console.log(`Total btn7 lines: ${btn7Lines.length}`);

// Print a few lines where btn7 changes pins
let lastPinsStr = '';
btn7Lines.forEach(line => {
    const pinsMatch = line.match(/pins: ({[^}]+})/);
    if (pinsMatch) {
        const pinsStr = pinsMatch[1];
        if (pinsStr !== lastPinsStr) {
            console.log(line);
            lastPinsStr = pinsStr;
        }
    }
});
