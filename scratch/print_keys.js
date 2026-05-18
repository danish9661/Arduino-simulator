const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/Danish/Documents/simulator/workflow/simulation-telemetry-protocol-2026-05-18T14-01-37-644Z.json', 'utf8'));
console.log('Keys of telemetry protocol JSON:', Object.keys(data));
// Let's print a sample if it has a list of reports or logs
for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) {
        console.log(`Key "${key}" is array of length ${data[key].length}`);
        if (data[key].length > 0) {
            console.log('Sample item:', JSON.stringify(data[key][0], null, 2));
        }
    } else {
        console.log(`Key "${key}" type is ${typeof data[key]}`);
    }
}
