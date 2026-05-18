const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-protocol-2026-05-18T14-01-37-644Z.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('Total entries:', data.telemetryEntries.length);

// Let's filter for all entries of btn7
const btn7Entries = data.telemetryEntries.filter(entry => entry.details && entry.details.id === 'btn7');
console.log('btn7 entries count:', btn7Entries.length);

let lastPinsStr = '';
btn7Entries.forEach((entry, idx) => {
    const pinsStr = JSON.stringify(entry.details.state?.pins);
    if (pinsStr !== lastPinsStr || idx === btn7Entries.length - 1) {
        console.log(`[Entry ${idx}] timestamp: ${entry.timestamp}`);
        console.log(`  pressed: ${entry.details.state?.pressed}`);
        console.log(`  pins: ${pinsStr}`);
        console.log(`  pinToggles: ${JSON.stringify(entry.details.state?.pinToggles)}`);
        lastPinsStr = pinsStr;
    }
});
