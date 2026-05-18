const fs = require('fs');

console.log('--- execute.ts ---');
const content = fs.readFileSync('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('onEvent') || line.includes('dispatchEvent') || line.includes('handleEvent')) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});

console.log('--- simulation.worker.ts ---');
const wContent = fs.readFileSync('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/simulation.worker.ts', 'utf8');
const wLines = wContent.split('\n');
wLines.forEach((line, idx) => {
    if (line.includes('event') || line.includes('message') || line.includes('onEvent')) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});
