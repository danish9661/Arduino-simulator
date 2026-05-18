const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('--- btn7 and Pin 5 Wires ---');
data.connections.forEach((conn, idx) => {
    const from = conn.from || '';
    const to = conn.to || '';
    if (from.includes('btn7') || to.includes('btn7') || from.includes('uno1:5') || to.includes('uno1:5')) {
        console.log(`${idx}: ${from} -> ${to} (id: ${conn.id})`);
    }
});
