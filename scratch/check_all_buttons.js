const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

for (let i = 1; i <= 8; i++) {
    const btnId = `btn${i}`;
    const btn = data.components.find(c => c.id === btnId);
    const wires = data.connections.filter(w => w.from.startsWith(btnId + ':') || w.to.startsWith(btnId + ':'));
    console.log(`Button ${btnId}: key="${btn?.attrs?.key}"`);
    wires.forEach(w => {
        console.log(`  Wire: ${w.from} -> ${w.to}`);
    });
}
