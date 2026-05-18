const fs = require('fs');
const content = fs.readFileSync('C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-2026-05-18T14-04-56-052Z.log', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < Math.min(25, lines.length); i++) {
    console.log(`${i + 1}: ${lines[i]}`);
}
