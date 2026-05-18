const fs = require('fs');
const content = fs.readFileSync('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src/worker/execute.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('repropagateAllVoltages')) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});
