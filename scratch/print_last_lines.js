const fs = require('fs');
const content = fs.readFileSync('C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-2026-05-18T14-04-56-052Z.log', 'utf8');
const lines = content.split('\n').filter(Boolean);
console.log(`Total lines: ${lines.length}`);
for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
}
