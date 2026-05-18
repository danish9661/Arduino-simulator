const fs = require('fs');

const logPath = 'C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-2026-05-18T14-04-56-052Z.log';
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

const matched = lines.filter(l => l.includes('19:57:23') || l.includes('19:57:24'));
console.log(`Matched lines count: ${matched.length}`);
matched.forEach(l => {
    if (l.includes('btn7') || l.includes('uno') || l.includes('buzzer')) {
        console.log(l);
    }
});
