const fs = require('fs');

const content = fs.readFileSync('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts', 'utf8');
const lines = content.split('\n');
let start = -1;
lines.forEach((line, idx) => {
    if (line.includes('traversePassive')) {
        console.log(`${idx + 1}: ${line.trim()}`);
        if (start === -1) start = idx;
    }
});

if (start !== -1) {
    console.log('--- Implementation ---');
    console.log(lines.slice(start - 2, start + 50).join('\n'));
}
